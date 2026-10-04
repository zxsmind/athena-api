# Smart Routing Core Entegrasyon Planı

> **Current status (2026-09-30):** Smart Routing is active through `server/src/smart-routing-bridge.ts`. Model HTTP and SSE transport now use AI SDK in `server/src/llm.ts`; the old transport-specific steps below are historical and must not be reintroduced. Current ownership is in `docs/ARCHITECTURE.md`.

> **ZORUNLU:** Bu projede çalışan her AI ajanı, smart routing ile ilgili herhangi bir kod değişikliğine başlamadan ÖNCE bu dokümanı baştan sona okumalıdır.
> Bu doküman, AGENTS.md'nin 5.3 ve 8. bölümleriyle birlikte ele alınmalıdır.

## Hedef

Mevcut linear target rotasyonunu (`llm.ts`'deki sabit sıralı döngü) Smart Routing Core'un skor tabanlı, öğrenen seçim motoruyla değiştirmek. Mevcut `tryProvider`/`tryProviderStream` HTTP çağrı mantığı **korunacak**, sadece **hedef seçim** ve **sonuç kaydı** katmanı değişecek.

---

## Adım 1: Build Altyapısı

Smart routing core şu an `server/package.json`'da tanımlı ama import edilmiyor.

### Yapılacaklar:

1. `smart-routing-core/tsconfig.json` kontrol et, `dist/` çıktısını ürettiğinden emin ol
2. `server/package.json`'da `"@mindbox/smart-routing-core": "file:../smart-routing-core"` zaten var
3. `server/package.json`'a `"prebuild"` script'i ekle: `cd ../smart-routing-core && npm run build`
4. Test et: `import { createSmartRoutingEngine } from '@mindbox/smart-routing-core'` çalışıyor mu

### Başarı Kriteri:
- `server/` içinde `npm run build` çalıştığında smart-routing-core de build olur
- `import` hatasız çalışır

---

## Adım 2: SmartRoutingBridge Katmanı

`server/src/smart-routing-bridge.ts` — mevcut sistemle smart routing arasında köprü.

### Yeni Dosya Yapısı:

```
server/src/
├── llm.ts                       # tryProvider/tryProviderStream korunur
├── llm-utils.ts                 # resolveTargets → bridge.selectTarget() çağırır
├── smart-routing-bridge.ts      # YENİ
└── engine/cooldown.ts           # KORUNUR
```

### Bridge API Tasarımı:

```typescript
class SmartRoutingBridge {
  private engine: SmartRoutingEngine;

  buildCandidates(role?: LLMRole): {
    candidates: RouteCandidate[];
    providerMap: Map<string, { providerId: string; model: string }>;
  }

  selectTarget(role?: LLMRole): {
    target: TargetReference;
    leaseId: string;
    routeId: string;
  } | null

  recordOutcome(
    leaseId: string,
    kind: 'success' | 'rate-limit' | 'transient-failure' | 'auth-failure',
    extra?: {
      usage?: { tokens?: number; requests?: number };
      retryAfterMs?: number;
      observations?: CapacityObservation[];
    }
  ): void

  getMinRecoveryMs(): number | null
  saveSnapshot(): void
  loadSnapshot(): void
}
```

### Önemli Tasarım Kararları:

| Karar | Sebep |
|-------|-------|
| Her `{providerId, model}` çifti bir `RouteCandidate` | Aynı provider'ın farklı modelleri farklı limitlere sahip olabilir |
| `scopeId` = `"groq/llama3-70b"` formatı | Uniq, provider+model'i net taşır |
| `rotationGroupId` = `providerId` | Aynı provider'ın tüm modelleri aynı grup sayılır (provider pressure tek noktadan) |
| `rotationIndex` = providerOrder index'i | Sıralı fallback'in aksine scoring tabanlı |
| `limits` = boş `{}` (öğrenmeye bırak) | Smart routing telemetry/behavioral inference ile limitleri kendisi keşfetsin |
| Snapshot `server/data/smart-routing-snapshot.json` | Sunucu restart'ında öğrenme kaybolmasın |
| Cooldown sistemi korunur | Deep mod round pacing bağımsız bir konsept |

### Test Senaryoları:

- Hiç provider yoksa `selectTarget()` null döner
- Tek provider + model varsa her zaman onu seçer
- 429 kaydedilen scope bir süre seçilmez
- Snapshot kaydedilip geri yüklenebilir

---

## Adım 3: callLLM / callLLMStream Değişimi

### Mevcut (KALDIRILACAK):

```typescript
for (let attempt = 0; attempt < maxGlobalAttempts; attempt++) {
  if (attempt > 0) await globalRetryBackoff(attempt, opts, label);
  for (const target of uniqTargets) {
    const result = await tryProvider(target, opts, body, label, tried);
    if (result) return result;
  }
}
throw new Error(...);
```

### Yeni:

```typescript
while (true) {
  const selection = bridge.selectTarget(role);
  if (!selection) {
    const waitMs = bridge.getMinRecoveryMs();
    if (waitMs && waitMs > 0) {
      await sleep(Math.min(waitMs, 30000));
      continue;
    }
    throw new Error("all targets failed — no route available");
  }

  const result = await tryProvider(selection.target, ...);

  if (result) {
    bridge.recordOutcome(selection.leaseId, 'success', { usage, observations });
    return result;
  }

  // Hata tipine göre outcome kaydet
  if (429)        bridge.recordOutcome(leaseId, 'rate-limit', { retryAfterMs });
  else if (401)   bridge.recordOutcome(leaseId, 'auth-failure');
  else if (400/404/413/timeout/network)
                  bridge.recordOutcome(leaseId, 'transient-failure');

  // Loop back — smart routing auto-skips blocked scopes
}
```

### Önemli Farklar:

- Global retry loop kalkıyor (smart routing `blockedUntil` ile zaten yönetiyor)
- `resolveTargets()` önceden tüm liste çıkarmaz; her seferinde `bridge.selectTarget()` çağrılır
- Sabit 2s/4s/8s/16s backoff yerine smart routing'in adaptive backoff'u (60s base, 15dk cap, Retry-After saygılı)
- `tried[]` listesi yerine `selectTarget()` döngüsü içinde hata mesajı biriktirilir

---

## Adım 4: CapacityObservation Besleme

Başarılı yanıtlardan limit header'larını parse edip smart routing'e bildirmek.

### Yapılacaklar:

`tryProvider` ve `tryProviderStream` içinde, başarılı yanıtta:

```typescript
const observations: CapacityObservation[] = [];

// Provider limit header'larını parse et
if (res.headers.get('x-ratelimit-limit-requests')) {
  observations.push({
    scopeId: `${target.id}/${model}`,
    source: 'response-header',
    observedAt: new Date().toISOString(),
    request: {
      limit: parseLimit,
      remaining: parseRemaining,
      resetAt: parseResetAt,
    },
  });
}

// Retry-After bilgisini de kapasite gözlemi olarak ekle
if (retryAfterMs > 0) {
  observations.push({
    scopeId: `${target.id}/${model}`,
    source: 'retry-after',
    observedAt: new Date().toISOString(),
    retryAfterSeconds: retryAfterMs / 1000,
  });
}

bridge.recordOutcome(leaseId, 'success', { usage, observations });
```

Ayrıca token kullanımını `BehavioralEvidence` olarak göndermek faydalı olur:
```typescript
behavioralEvidence: [{
  scopeId: `${target.id}/${model}`,
  requestCount: 1,
  tokenCount: estimatedTokens,
}]
```

---

## Adım 5: Temizlik ve Test

### Kaldırılacak Dosyalar/Fonksiyonlar:

| Dosya/Fonksiyon | Durum |
|----------------|-------|
| `llm-utils.ts: resolveTargets()` | KALDIR |
| `llm-utils.ts: resolveRoleTargetReferences()` | KALDIR |
| `llm-utils.ts: iterateProviderReferences()` | KALDIR |
| `llm-utils.ts: modelSupportsTools()` | KALDIR (tool hatası → transient-failure) |
| `llm-utils.ts: learnedNoToolCalling` | KALDIR |
| `llm-utils.ts: NO_TOOL_CALLING_MODELS` | Smart routing config'ine taşınabilir |
| `llm.ts: globalRetryBackoff()` | KALDIR |
| `engine/rate-signals.ts` | KALDIR (429 takibi smart routing'de) |
| `llm.ts: recordRateLimitHit/Success` | KALDIR |
| `llm.ts: parseRetryAfterMs()` | Bridge'e taşınabilir |

### Test Dosyaları:

- `server/tests/research-jobs.test.ts` — güncelle (smart routing import testi)
- `server/tests/research-batches.test.ts` — güncelle
- `server/tests/smart-routing-bridge.test.ts` — YENİ (bridge birim testleri)

### Test Edilecek Davranışlar:

- Snapshot save/load cycle
- selectTarget null dönüşü
- rate-limit sonrası scope blocking
- Retry-After'a uygun bekleme
- Birden çok concurrent çağrı

---

## Adım 6: AGENTS.md ve Dokümantasyon Güncelleme

1. AGENTS.md 5.3 bölümü güncellenir: "Smart Routing — paket mevcut, backend'de henüz bağlı değil" → "Smart Routing — aktif olarak kullanılıyor"
2. AGENTS.md 6.3 bölümü güncellenir: `learnedNoToolCalling` referansı kaldırılır
3. AGENTS.md 8.1 "Yeni LLM Provider Ekleme" senaryosu güncellenir (bridge üzerinden)
4. Bu plan dosyası (docs/smart-routing-integration-plan.md) AGENTS.md'de referans olarak eklenir
5. AGENTS.md 8.6 "Deploy / Update" kısmına snapshot dosyasının (.deploy-state gibi) korunması gerektiği eklenir

---

## Toplam İş Yükü

| Adım | Süre |
|------|------|
| 1. Build altyapısı | 1-2 saat |
| 2. Bridge katmanı | 3-4 saat |
| 3. callLLM değişimi | 2-3 saat |
| 4. CapacityObservation besleme | 1-2 saat |
| 5. Temizlik + test | 2 saat |
| 6. Dokümantasyon | 30 dk |
| **Toplam** | **~10-14 saat** |

---

## Riskler ve Dikkat Edilmesi Gerekenler

| Risk | Açıklama | Mitigasyon |
|------|----------|------------|
| Smart routing henüz üretimde test edilmedi | `smart-routing-core` bu projeye özel yazılmış | Mevcut sistemi koru, bridge'i yan dalda geliştir, A/B karşılaştırması yap |
| Lease süresi yönetimi | Her LLM çağrısı için lease alınır, çağrı bitince kapatılır | Default lease TTL 2dk, streaming çağrılar için lease TTL'yi `maxTokens * estimatedPerToken` olarak ayarla |
| Snapshot dosya yarışı | Concurrent istekler aynı anda snapshot okuyup yazabilir | `loadSettings()` gibi 2s cache + write lock ile çöz |
| Cooldown ile çakışma | Smart routing rate limit blocking yaparken, cooldown da ayrı bir bekletme uyguluyor | Cooldown sadece deep round pacing içindir (search/fetch arası bekleme), smart routing ise LLM API seçimi. İkisi farklı katmanlarda sorunsuz çalışır |
| Frontend/Settings değişikliği | Mevcut `modelRouting` ayarları (primary + fallback) aynen kalabilir | Bridge bunları `RouteCandidate[]`'e çevirir. Ayarlarda değişiklik gerekmez, geriye uyumlu |

---

## Özet Karşılaştırma

| Özellik | Şu An | Smart Routing ile |
|---------|-------|-------------------|
| Hedef seçim | Sabit sıra (primary→fallback→tümü) | Skor tabanlı (capacity + success rate + probation) |
| Rate limit sonrası | Sıradaki key'i dene, sonra model/provider atla | Scope'u `blockedUntil` ile bloke et, smart routing diğerini seçer |
| Retry-After saygısı | Sadece deep cooldown'da | Her seviyede: `blockedUntil` timestamp olarak |
| Öğrenme | Yok (her çağrı sıfırdan) | Var (snapshot serialize/deserialize, kalıcı) |
| Aynı hatayı tekrar | Aynı key/model başta tekrar dener | Bloke edilen atlanır, alternatif seçilir |
| 400/404 sonrası | `learnedNoToolCalling` (session lifetime) | `transient-failure` → adaptive block + probation |
| Kod karmaşıklığı | ~150 satır fallback mantığı | ~30 satır + bridge 200 satır |

---

## Tamamlama Kriterleri

- [ ] Adım 1: `npm run build` server'da hatasız çalışıyor
- [ ] Adım 2: Bridge tüm birim testlerini geçiyor
- [ ] Adım 3: Quick ve Deep mod LLM çağrıları smart routing üzerinden çalışıyor
- [ ] Adım 4: 429 sonrası `Retry-After`'a uygun bekleme yapılıyor
- [ ] Adım 5: Tüm eski fallback kodu temizlenmiş, testler geçiyor
- [ ] Adım 6: AGENTS.md güncellenmiş
- [ ] E2E test: `npm run dev` + `npm run dev` (frontend/backend) ile gerçek arama çalışıyor
