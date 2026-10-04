# Deep Depth Presets Plan

> **Superseded (2026-09-30):** `server/src/engine/depth-presets.ts` no longer exists. The budget vocabulary now lives in `server/src/engine/budget.ts` as a single set of presets, and the `researchDepths` settings override was removed: depth is derived from the mode's default budget profile. This file is kept only as the original design record. The current contract is `docs/API.md` and `docs/DOMAIN.md`.

## 1. Amaç

ATHENA-001 araştırma modları iki seviyeli bir modele taşınacak:

- `instant`: Anında cevap veya hızlı web destekli cevap.
- `deep`: Notebook destekli derin araştırma motoru.

`deep` modu kendi içinde dört preset'e ayrılacak:

- `low`: Derin ama hızlı cevap, hedef süre 1-2 dakika.
- `med`: Derin ve dengeli araştırma, hedef süre 5-10 dakika.
- `high`: Agresif doğrulama ve derin araştırma, hedef süre 30 dakika-1 saat.
- `ultra`: Çok uzun süreli, en yüksek doğruluk hedefli araştırma, hedef süre 3 saat-1 gün.

Bu tasarımın hedefi sadece budget yükseltmek değildir. Her preset araştırma davranışını, notebook cadence'ini, cooldown stratejisini, kaynak doğrulama seviyesini ve kullanıcı beklentisini birlikte tanımlar.

## 2. Tasarım İlkeleri

1. Tek deep motor kullanılmalı.
2. `low`, `med`, `high`, `ultra` ayrı engine fork'ları olmamalı; aynı notebook-first loop'a preset uygulanmalı.
3. Guard-loop yaklaşımından kaçınılmalı. Model final cevap vermeye çalıştığında sürekli reddetmek yerine, baştan doğru araştırma protokolü ve notebook davranışı verilmeli.
4. Cooldown statik sleep olmamalı. Provider hata oranı, rate-limit sinyalleri, son tool latency'leri ve depth preset'e göre dinamik hesaplanmalı.
5. Notebook, deep modun ana çalışma belleği olmalı. Raw search/fetch payload'ları notebook'a yazıldıktan sonra context'ten kompaktlanmalı.
6. Uzun modlar iptal edilebilir, izlenebilir ve resume edilebilir olacak şekilde tasarlanmalı.
7. UI kullanıcıya süre/maliyet beklentisini açıkça göstermeli.
8. Ultra mod "yüzde yüz doğruluk" iddiasını ürün dilinde dikkatli kullanmalı: hedef en yüksek doğruluk ve çoklu doğrulama olmalı; kanıt bulunamayan konularda kesinlik iddia edilmemeli.

## 3. Hedef Kullanıcı Deneyimi

### 3.1. Modlar

| UI modu | API mode | depth | Kullanım amacı | Hedef süre |
|---|---|---|---|---|
| Instant | `quick` | yok | Hızlı cevap, basit web destekli yanıt | saniyeler |
| Deep Low | `deep` | `low` | Hızlı ama ciddi araştırma | 1-2 dk |
| Deep Med | `deep` | `med` | Dengeli ve kapsamlı araştırma | 5-10 dk |
| Deep High | `deep` | `high` | Güçlü doğrulama, geniş kaynak tarama | 30 dk-1 saat |
| Deep Ultra | `deep` | `ultra` | Çok uzun, çoklu doğrulamalı araştırma | 3 saat-1 gün |

### 3.2. UI Beklentisi

Arama input'unda tek bir "mode" dropdown yerine iki seviyeli seçim önerilir:

- Primary toggle: `Instant` / `Deep`
- Deep seçilirse depth selector: `Low`, `Med`, `High`, `Ultra`

Alternatif sade UI:

- `Instant`
- `Deep Low`
- `Deep Med`
- `Deep High`
- `Deep Ultra`

Deep High ve Ultra için kullanıcıya açık uyarı gösterilmeli:

- Tahmini süre.
- Daha fazla API kullanımı.
- İşin arka planda devam edeceği.
- İptal edilebilir olduğu.
- Sonucun notebook'a dayalı üretileceği.

## 4. Preset Tanımları

### 4.1. Deep Low

Hedef: Derin mod davranışını koruyarak hızlı sonuç vermek.

Önerilen başlangıç değerleri:

```ts
{
  depth: 'low',
  budgetCredits: 20,
  maxRounds: 5,
  targetDurationMs: 120_000,
  initialCooldownMs: [5_000, 10_000],
  notebookCadenceRawBlocks: 2,
  maxSearchesPerRound: 4,
  maxFetchesPerRound: 2,
  minIndependentSourcesForKeyClaims: 2,
  contradictionPass: false,
  resumeEnabled: false
}
```

Davranış:

- İlk turda geniş ama sınırlı arama.
- Notebook her 1-2 raw evidence batch sonrası güncellenir.
- Fetch sadece yüksek değerli kaynaklar için yapılır.
- Sonuç kullanıcıya kısa/orta uzunlukta verilir.

### 4.2. Deep Med

Hedef: Varsayılan derin araştırma deneyimi.

Önerilen başlangıç değerleri:

```ts
{
  depth: 'med',
  budgetCredits: 35,
  maxRounds: 8,
  targetDurationMs: 600_000,
  initialCooldownMs: [10_000, 15_000],
  notebookCadenceRawBlocks: 2,
  maxSearchesPerRound: 5,
  maxFetchesPerRound: 3,
  minIndependentSourcesForKeyClaims: 2,
  contradictionPass: true,
  resumeEnabled: true
}
```

Davranış:

- Kullanıcı sorgusu alt kanıtlara ayrılır.
- Kaynaklar arası temel cross-check yapılır.
- Belirsiz veya çelişkili noktalar notebook'ta açık tutulur.
- Final cevap notebook'taki açık sorular kapandıktan sonra üretilir.

### 4.3. Deep High

Hedef: Agresif doğrulama, yüksek güvenilirlik, daha fazla fetch ve cross-check.

Önerilen başlangıç değerleri:

```ts
{
  depth: 'high',
  budgetCredits: 50,
  maxRounds: 13,
  targetDurationMs: 3_600_000,
  initialCooldownMs: [20_000, 40_000],
  notebookCadenceRawBlocks: 1,
  maxSearchesPerRound: 6,
  maxFetchesPerRound: 4,
  minIndependentSourcesForKeyClaims: 3,
  contradictionPass: true,
  primarySourcePreference: true,
  resumeEnabled: true
}
```

Davranış:

- Her ana iddia için birden fazla bağımsız kaynak aranır.
- Snippet yeterli görülmez; kritik kaynaklarda `fetch_url` tercih edilir.
- Çelişki varsa ek arama yapılır.
- Notebook cadence daha agresiftir; context şişmeden araştırma sürer.
- UI'da daha uzun bekleme ve arka plan job davranışı beklenir.

### 4.4. Deep Ultra

Hedef: En kapsamlı araştırma. Uzun süreli, çoklu doğrulamalı, notebook merkezli araştırma.

Önerilen başlangıç değerleri:

```ts
{
  depth: 'ultra',
  budgetCredits: 100,
  maxRounds: 30,
  targetDurationMs: 86_400_000,
  initialCooldownMs: [60_000, 60_000],
  notebookCadenceRawBlocks: 1,
  maxSearchesPerRound: 8,
  maxFetchesPerRound: 6,
  minIndependentSourcesForKeyClaims: 3,
  contradictionPass: true,
  primarySourcePreference: true,
  exhaustiveGapReview: true,
  resumeEnabled: true,
  checkpointEveryRounds: 2
}
```

Davranış:

- Araştırma tek oturumda bitebilecek varsayılmamalı.
- Notebook dosyası işin ana state kaynağıdır.
- Job resume ve checkpoint zorunlu hale gelmelidir.
- Provider cooldown ve rate-limit uyumu agresif değil, sabırlı olmalıdır.
- Final cevap kapsamlı rapor formatına yaklaşabilir.
- Kanıt bulunamayan konularda "kesin" denmemeli; denenen aramalar ve kanıt durumu açıkça yazılmalı.

## 5. API Tasarımı

### 5.1. Request Şeması

Mevcut:

```ts
{
  query: string;
  mode?: 'quick' | 'deep';
  history?: Message[];
  conversationId?: string;
}
```

Önerilen:

```ts
type SearchMode = 'quick' | 'deep';
type DeepDepth = 'low' | 'med' | 'high' | 'ultra';

interface SearchRequest {
  query: string;
  mode?: SearchMode;
  depth?: DeepDepth;
  history?: { role: string; content: string }[];
  conversationId?: string;
}
```

Kurallar:

- `mode: 'quick'` ise `depth` yok sayılır.
- `mode: 'deep'` ve `depth` verilmezse default `med` önerilir.
- Geriye uyumluluk için eski deep çağrıları `depth: 'med'` kabul edilir.

### 5.2. Job Şeması

```ts
interface ResearchJobRecord {
  mode: 'quick' | 'deep';
  depth?: 'low' | 'med' | 'high' | 'ultra';
  preset?: ResearchPresetSnapshot;
}
```

`preset` snapshot olarak job içine yazılmalı. Böylece kullanıcı ayar değiştirirse aktif job davranışı ortada değişmez.

### 5.3. Response Şeması

```ts
interface SearchResponse {
  query: string;
  answer: string;
  sources: Source[];
  steps: AgentStep[];
  results_count: number;
  elapsed_ms: number;
  research_budget?: {
    used: number;
    limit: number;
    exhausted: boolean;
  };
  research_depth?: 'low' | 'med' | 'high' | 'ultra';
  research_notebook?: {
    id: string;
    path: string;
    entries: number;
    updatedAt: string;
  };
}
```

## 6. Settings Tasarımı

### 6.1. Settings Store

`settings-store.ts` içinde yeni alan:

```ts
researchDepths: {
  defaultDepth: 'med',
  presets: {
    low: ResearchDepthPreset,
    med: ResearchDepthPreset,
    high: ResearchDepthPreset,
    ultra: ResearchDepthPreset
  }
}
```

Preset tipi:

```ts
interface ResearchDepthPreset {
  budgetCredits: number;
  maxRounds: number;
  minCooldownMs: number;
  maxCooldownMs: number;
  notebookCadenceRawBlocks: number;
  maxSearchesPerRound: number;
  maxFetchesPerRound: number;
  minIndependentSourcesForKeyClaims: number;
  contradictionPass: boolean;
  primarySourcePreference: boolean;
  exhaustiveGapReview: boolean;
  checkpointEveryRounds: number;
}
```

### 6.2. Defaults

Başlangıç defaults:

```ts
low: {
  budgetCredits: 20,
  maxRounds: 5,
  minCooldownMs: 5_000,
  maxCooldownMs: 10_000,
  notebookCadenceRawBlocks: 2,
  maxSearchesPerRound: 4,
  maxFetchesPerRound: 2,
  minIndependentSourcesForKeyClaims: 2,
  contradictionPass: false,
  primarySourcePreference: false,
  exhaustiveGapReview: false,
  checkpointEveryRounds: 0
}
```

```ts
med: {
  budgetCredits: 35,
  maxRounds: 8,
  minCooldownMs: 10_000,
  maxCooldownMs: 15_000,
  notebookCadenceRawBlocks: 2,
  maxSearchesPerRound: 5,
  maxFetchesPerRound: 3,
  minIndependentSourcesForKeyClaims: 2,
  contradictionPass: true,
  primarySourcePreference: false,
  exhaustiveGapReview: false,
  checkpointEveryRounds: 0
}
```

```ts
high: {
  budgetCredits: 50,
  maxRounds: 13,
  minCooldownMs: 20_000,
  maxCooldownMs: 40_000,
  notebookCadenceRawBlocks: 1,
  maxSearchesPerRound: 6,
  maxFetchesPerRound: 4,
  minIndependentSourcesForKeyClaims: 3,
  contradictionPass: true,
  primarySourcePreference: true,
  exhaustiveGapReview: false,
  checkpointEveryRounds: 2
}
```

```ts
ultra: {
  budgetCredits: 100,
  maxRounds: 30,
  minCooldownMs: 60_000,
  maxCooldownMs: 60_000,
  notebookCadenceRawBlocks: 1,
  maxSearchesPerRound: 8,
  maxFetchesPerRound: 6,
  minIndependentSourcesForKeyClaims: 3,
  contradictionPass: true,
  primarySourcePreference: true,
  exhaustiveGapReview: true,
  checkpointEveryRounds: 2
}
```

## 7. Dynamic Cooldown Tasarımı

### 7.1. Amaç

Cooldown iki şeyi dengeler:

- Provider rate-limit ve hata oranını düşürmek.
- Uzun research job'larda kaynakları kontrollü kullanmak.

Cooldown sadece `sleep(depthDefault)` olmamalıdır. Her tool batch veya LLM call sonrası güncel sinyallerle hesaplanmalıdır.

### 7.2. Sinyaller

Kullanılacak sinyaller:

- Son N LLM call hata oranı.
- Son N search/fetch hata oranı.
- 429 veya retry-after gözlemleri.
- Smart routing provider pressure.
- Ortalama latency.
- Kalan budget.
- Kalan round.
- Depth preset.
- Aktif job sayısı.

### 7.3. Formül

Başlangıç:

```ts
base = randomBetween(preset.minCooldownMs, preset.maxCooldownMs)
```

Ceza katsayıları:

```ts
errorPenalty = recentErrorRate * 2.0
rateLimitPenalty = recent429Count > 0 ? 1.5 : 0
latencyPenalty = avgLatencyMs > 20_000 ? 0.5 : 0
pressurePenalty = providerPressureScore
```

Azaltma katsayıları:

```ts
healthyBonus = recentSuccessStreak >= 5 ? -0.25 : 0
urgentBonus = remainingRounds <= 2 && depth !== 'ultra' ? -0.15 : 0
```

Final:

```ts
cooldownMs = clamp(
  base * (1 + errorPenalty + rateLimitPenalty + latencyPenalty + pressurePenalty + healthyBonus + urgentBonus),
  preset.minCooldownMs,
  preset.maxCooldownMs * 4
)
```

Ultra için özel kural:

- Cooldown asla 60 saniyenin altına düşmemeli.
- 429 varsa `retry-after` öncelikli olmalı.
- Art arda hata varsa cooldown 5 dakikaya kadar çıkabilmeli.

### 7.4. Cooldown Nerede Uygulanır?

Cooldown şu noktalarda uygulanmalı:

1. Search/fetch batch tamamlandıktan sonra sonraki LLM tool round öncesi.
2. LLM provider 429/timeout sonrası retry öncesi.
3. Ultra ve high modlarda büyük batch'ler arasında.

Cooldown notebook yazımı için uygulanmamalı; notebook lokal disk işlemidir.

## 8. Notebook Entegrasyonu

### 8.1. Mevcut Durum

Deep modda `write_notebook` tool'u vardır. Notebook `server/data/notebooks/*.json` altına yazılır. Notebook yazıldığında raw `Source #...` payload'ları context içinde kompaktlanır.

### 8.2. Depth Bazlı Notebook Cadence

| Depth | Cadence |
|---|---|
| low | 2 raw block |
| med | 2 raw block |
| high | 1 raw block |
| ultra | 1 raw block |

Davranış:

- Cadence eşiği aşılırsa engine soft system message ile `write_notebook` önerir.
- Final cevap reddedilmez.
- Yeni search/fetch yapmadan önce notebook yazması istenir.
- High/Ultra'da notebook yazımı daha sık teşvik edilir.

### 8.3. Checkpoint

High ve Ultra için notebook sadece context compaction değil, resume state olarak da kullanılmalıdır.

Checkpoint içeriği:

```ts
{
  jobId: string;
  depth: DeepDepth;
  preset: ResearchDepthPreset;
  notebookId: string;
  usedCredits: number;
  remainingCredits: number;
  round: number;
  sourceMap: SourceWithIndex[];
  lastUpdatedAt: string;
}
```

Checkpoint dosya konumu:

```text
server/data/research-checkpoints/{jobId}.json
```

Bu dosyalar da gitignore içinde olmalıdır.

## 9. Engine Değişiklik Planı

### Faz 1: Tipler ve API

1. `DeepDepth` tipi ekle.
2. `SearchRequest`, `ResearchJobRequest`, `ResearchBatchRequest` içine `depth?: DeepDepth` ekle.
3. `ResearchJobRecord` içine `depth` ve `preset` snapshot ekle.
4. `SearchResponse` içine `research_depth` ekle.
5. Eski deep istekleri için default `depth = 'med'` yap.

Acceptance criteria:

- Eski `mode: 'deep'` çağrıları kırılmadan çalışır.
- `mode: 'quick'` depth değerini yok sayar.
- Job response depth bilgisini taşır.

### Faz 2: Preset Resolver

1. `server/src/engine/depth-presets.ts` oluştur.
2. Default presetleri tanımla.
3. Settings override desteği ekle.
4. `resolveResearchPreset(mode, depth, settings)` fonksiyonu yaz.
5. Batch jobs için per-item preset snapshot üret.

Acceptance criteria:

- Low/med/high/ultra için doğru budget ve maxRounds resolve edilir.
- Settings eksikse defaults kullanılır.
- Invalid depth `med` fallback yapar veya 400 döner; karar API seviyesinde netleşmelidir. Öneri: public API'de 400, internal fallback'te `med`.

### Faz 3: Engine Parametreleri

1. `maxRounds = preset.maxRounds`.
2. `budget.remainingCredits = preset.budgetCredits`.
3. `maxSearchesPerRound` ve `maxFetchesPerRound` tool task slicing'e uygulanır.
4. Notebook cadence threshold preset'ten gelir.
5. Deep prompt'a depth-specific behavior block eklenir.

Acceptance criteria:

- Deep low 20 kredi ve 5 round ile çalışır.
- Deep med 35 kredi ve 8 round ile çalışır.
- Deep high 50 kredi ve 13 round ile çalışır.
- Deep ultra 100 kredi ve 30 round ile çalışır.

### Faz 4: Dynamic Cooldown

1. `server/src/engine/cooldown.ts` oluştur.
2. `ResearchCooldownState` tipi ekle.
3. Tool batch sonuçlarından latency/error sinyali kaydet.
4. LLM failure ve smart routing pressure sinyallerini mümkün olduğu ölçüde bağla.
5. Cooldown event'i SSE step olarak gönder:

```ts
{ type: 'cooldown', note: 'Waiting 15s due to deep-med pacing' }
```

Acceptance criteria:

- Low/med/high/ultra farklı cooldown aralıkları uygular.
- 429 sonrası cooldown artar.
- Başarılı seri sonrası low/med cooldown hafif azalabilir.
- İptal sinyali cooldown sırasında çalışır.

### Faz 5: UI

1. `ModeDropdown` veya yeni `ResearchModeSelector` tasarla.
2. Deep seçildiğinde depth seçimi göster.
3. Chat state ve navigation state içinde `depth` taşı.
4. `src/lib/api.ts` request tiplerine `depth` ekle.
5. Activity panelde depth ve notebook bilgisi göster.
6. High/Ultra için süre ve kullanım uyarısı göster.

Acceptance criteria:

- Landing ve Chat ekranlarından depth seçilebilir.
- Follow-up sorularda önceki depth korunur.
- Instant davranışı değişmez.

### Faz 6: Settings UI

1. Settings modal Advanced veya Research sekmesine depth preset ayarları ekle.
2. Kullanıcı budget, rounds, cooldown aralığı ve notebook cadence değiştirebilir.
3. "Reset presets" aksiyonu eklenir.

Acceptance criteria:

- Presetler settings.json'a yazılır.
- Eksik veya bozuk ayarlar normalize edilir.
- UI sayısal alanlarda negatif/NaN değerleri engeller.

### Faz 7: Long-Running High/Ultra Hardening

1. Checkpoint dosyaları ekle.
2. Server restart sonrası job resume stratejisi tasarla.
3. Ultra job için SSE idle timeout davranışını gözden geçir.
4. Notebook ve checkpoint retention politikası ekle.
5. Cancel/pause/resume endpointleri değerlendir:

```text
POST /research-jobs/:id/pause
POST /research-jobs/:id/resume
```

Acceptance criteria:

- Ultra job iptal edilebilir.
- Notebook dosyası final response'ta referanslanır.
- Uzun araştırmalar frontend bağlantısı kopsa bile backend job olarak devam eder.

## 10. Prompt Stratejisi

Tek `DEEP_SYSTEM_PROMPT` korunabilir, ancak depth-specific ek blok verilmeli:

```text
Depth profile: high
- Favor primary sources.
- Use notebook after every evidence batch.
- Verify key claims with at least 3 independent sources.
- Investigate contradictions before final answer.
- Prefer fetch_url for authoritative pages.
```

Depth promptları ayrı dosyada tutulabilir:

```text
server/src/agent/depth-prompts.ts
```

Önemli:

- Prompt depth davranışını tanımlar.
- Engine preset limitleri uygular.
- Model final answer vermeye çalıştığında guard-loop yapılmaz.
- Notebook cadence soft instruction olarak verilir.

## 11. Source Verification Modeli

Başlangıçta tam otomatik claim verification zorunlu değildir. Notebook modeli şu alanları desteklemelidir:

```ts
verified_claims: string[];
open_questions: string[];
contradictions: string[];
source_urls: string[];
next_actions: string[];
```

High/Ultra için ileride genişletme:

```ts
claims: {
  text: string;
  status: 'unverified' | 'single-source' | 'verified' | 'conflicting';
  sourceUrls: string[];
  confidence: 'low' | 'medium' | 'high';
}[]
```

Bu ikinci aşamadır; ilk implementation için mevcut notebook schema yeterlidir.

## 12. Rate Limit ve Smart Routing Entegrasyonu

Dynamic cooldown, smart routing ile çakışmamalı. Smart routing route seçimi ve provider health kararlarını verir; cooldown engine pacing katmanıdır.

Sorumluluk ayrımı:

- Smart routing: hangi provider/key/model daha sağlıklı?
- Cooldown: bir sonraki tool/LLM round ne zaman başlamalı?
- Engine budget: kaç search/fetch yapılabilir?
- Notebook: context nasıl kompaktlanır ve araştırma state'i nasıl korunur?

Gelecek entegrasyon:

```ts
const pressure = smartRouting.getProviderPressure?.(providerId) ?? 0;
cooldownMs = computeCooldown({ preset, pressure, errors, latency });
```

## 13. Güvenlik ve Veri Saklama

Yeni runtime dosyaları:

```text
server/data/notebooks/
server/data/research-checkpoints/
```

Gitignore:

```text
server/data/notebooks/
server/data/research-checkpoints/
```

Dikkat:

- Notebook'lar kullanıcı sorgularını ve araştırma notlarını içerebilir.
- Notebook dosyaları commitlenmemeli.
- Remote deploy sırasında retention politikası tanımlanmalı.
- Settings içinde API key'ler zaten hassas kabul edilir; notebook hassas kullanıcı verisi olarak kabul edilmelidir.

## 14. Observability

SSE step tipleri:

```ts
'notebook'
'cooldown'
'checkpoint'
'verification'
```

Activity panelde gösterilecek alanlar:

- Depth.
- Kullanılan budget.
- Kalan budget.
- Notebook entry sayısı.
- Son notebook zamanı.
- Cooldown nedeni.
- Açık soru sayısı.

Loglama:

- Notebook write success/failure.
- Compacted raw block count.
- Cooldown duration and reason.
- Preset snapshot.
- Provider failures affecting cooldown.

## 15. Test Planı

### Unit Tests

1. Preset resolver defaults.
2. Invalid depth handling.
3. Settings normalization.
4. Cooldown formula clamp behavior.
5. Notebook cadence threshold.
6. Budget and maxRounds per depth.

### Integration Tests

1. `mode: deep`, no depth -> `med`.
2. `depth: low` creates 20-credit budget.
3. `depth: ultra` creates 100-credit budget.
4. Notebook write compacts raw context.
5. Cooldown respects AbortSignal.
6. Batch research passes depth per item.

### Manual Tests

1. Instant query.
2. Deep Low query.
3. Deep Med query.
4. Deep High query with cancellation.
5. Deep Ultra dry-run with reduced budget.
6. Server restart behavior for checkpointed jobs.

## 16. Migration Plan

1. Add types and defaults with no UI exposure.
2. Backend accepts `depth` but frontend still sends old mode.
3. Default old deep to `med`.
4. Add frontend selector.
5. Add settings UI.
6. Add dynamic cooldown.
7. Add checkpoint/resume for High/Ultra.

Bu sıra kullanıcı davranışını kırmadan ilerlemeyi sağlar.

## 17. Riskler

| Risk | Açıklama | Önlem |
|---|---|---|
| Ultra maliyeti yüksek | 100 kredi ve uzun süre maliyet üretir | UI uyarısı, cancel, budget display |
| Model notebook yazmayabilir | Context compaction tetiklenmez | Soft cadence, depth-specific prompt |
| Cooldown çok yavaşlatır | Kullanıcı işin takıldığını sanabilir | Activity panelde cooldown nedeni göster |
| Server restart job kaybı | Mevcut jobs in-memory | Checkpoint/resume fazı |
| Kaynak doğrulama illüzyonu | Model "verified" yazabilir ama gerçekte zayıf olabilir | Source URLs, contradiction tracking, future claim schema |
| UI karmaşası | Çok fazla seçenek kullanıcıyı bölebilir | Basit default: Instant + Deep Med |

## 18. Uygulama Önceliği

Önerilen sıra:

1. Backend depth types + preset resolver.
2. Engine budget/maxRounds/notebook cadence preset uygulaması.
3. API ve frontend depth taşıma.
4. UI mode selector.
5. Dynamic cooldown.
6. Settings UI.
7. High/Ultra checkpoint/resume.
8. Advanced claim verification schema.

Bu sırada ilk üç faz tamamlanınca kullanıcı Deep Low/Med/High/Ultra seçmeye başlayabilir. Cooldown ve checkpoint daha sonra davranışı güçlendirir.

## 19. Nihai Hedef Mimari

```text
User selects:
  Instant
  Deep Low
  Deep Med
  Deep High
  Deep Ultra

Frontend sends:
  { mode: 'deep', depth: 'high' }

Backend:
  resolve preset
  create job snapshot
  create notebook
  run agentic loop
  apply depth budget and rounds
  apply notebook cadence
  apply dynamic cooldown
  compact raw context after notebook writes
  checkpoint long jobs
  return answer + sources + notebook metadata
```

Bu model mevcut mimariyi tamamen atmadan büyütür. Quick/instant hızlı kalır; deep ise tek motor üzerinden farklı araştırma derinlikleri kazanır.
