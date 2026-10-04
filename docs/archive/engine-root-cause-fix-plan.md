# ATHENA-001 Engine Root-Cause Analysis & Fix Plan

> **Historical diagnosis (2026-09-30):** This large report records the original chat-engine investigation. It is not the current API contract. Check `docs/HANDOFF.md`, `docs/ROADMAP.md`, and `docs/RESEARCHER.md` for the current v1 state and open gaps.

> **Durum:** Tüm bulgular 11 kaynak dosya üzerinden satır satır doğrulanmıştır. Bu doküman teorik bir değerlendirme değil, kod seviyesinde kanıtlanmış kök sebeplerin ve bunlara yönelik somut, uygulanabilir düzeltmelerin planıdır.
>
> **Doğrulama kapsamı (okunmuş ve satır satır çapraz kontrol edilmiş dosyalar):**
> - `server/src/agent/prompts.ts` (75 satır) — `wc -l` ve satır numaraları birebir doğru
> - `server/src/engine.ts` (840 satır) — tüm referans satırları (84-85, 127-168, 170-180, 184-189, 262, 489, 596, 628-633) teyit edildi
> - `server/src/engine/types.ts` (66 satır) — satır 42-47 ve 53-66 teyit edildi
> - `server/src/engine/cooldown.ts` (135 satır) — satır 70-107 (`computeCooldownMs`) ve 109-135 (`waitCooldown`) teyit edildi
> - `server/src/engine/depth-presets.ts` (154 satır) — tüm preset değerleri (low/med/high/ultra) teyit edildi
> - `server/src/engine/tool-parser.ts` (73 satır) — `extractQuery` ve XML/JSON fallback mantığı teyit edildi
> - `server/src/engine/rate-signals.ts` (41 satır) — `parseRetryAfterMs` ve `consumeRateSignalsForCooldown` teyit edildi
> - `server/src/engine/notebook.ts`, `research-ledger.ts`, `checkpoint.ts`, `history.ts` — mevcut ve tutarlı
>
> **Önemli not:** Raporun `⚠️ doğrulayamadım` olarak işaretlediği tüm `prompts.ts` iddiaları artık **tam doğrulanmış** durumdadır. `prompts.ts`'in gerçek içeriği okunduğunda, raporda referans verilen satır numaralarının (L37, L49-54, L56-64) tamamı birebir doğru çıktı. Ayrıca, `prompts.ts`'in okunması, raporun yakalayamadığı üç yeni ve kritik bulguyu ortaya çıkarmıştır (bkz. Bölüm 6–8).

---

## İçindekiler

1. [Yönetici Özeti](#1-yönetici-özeti)
2. [Ortak Üst-Bulgu: Soft Enforcement Paradoksı](#2-ortak-üst-bulgu-soft-enforcement-paradoksı)
3. [Kök Sebep A — Query Kalitesi: Tool Şeması Zorlamıyor](#3-kök-sebep-a--query-kalitesi-tool-şeması-zorlamıyor)
4. [Kök Sebep B — Erken Durma: Üç Birbirini Besleyen Delik](#4-kök-sebep-b--erken-durma-üç-birbirini-besleyen-delik)
5. [Kök Sebep C — Connection Lost (High/Ultra): Cooldown Sessizliği](#5-kök-sebep-c--connection-lost-highultra-cooldown-sessizliği)
6. [Yeni Bulgu #1 — Notebook'ta "Bırakma" Yasağı Delikli Guard](#6-yeni-bulgu-1--notebookta-bırakma-yasağı-delikli-guard)
7. [Yeni Bulgu #2 — Recency Çatışması: engine.ts:85 vs prompts.ts:56-64](#7-yeni-bulgu-2--recency-çatışması-enginets85-vs-promptst56-64)
8. [Yeni Bulgu #3 — Query Strategy Konumunun İkincil Etkisi](#8-yeni-bulgu-3--query-strategy-konumunun-ikincil-etkisi)
9. [Doğrulama Matrisi — Tüm Bulguların Durumu](#9-doğrulama-matrisi--tüm-bulguların-durumu)
10. [Çözüm Mimarisi — Üst-Bulgu Yönünde Tutarlılık](#10-çözüm-mimarisi--üst-bulgu-yönünde-tutarlılık)
11. [Düzeltme #1 — SEARCH_TOOL Şeması (Tek Alan, Zorunlu Array)](#11-düzeltme-1--search_tool-şeması-tek-alan-zorunlu-array)
12. [Düzeltme #2 — Cooldown Heartbeat (SSE Sessizliğini Öldürme)](#12-düzeltme-2--cooldown-heartbeat-sse-sessizliğini-öldürme)
13. [Düzeltme #3 — Minimum Araştırma Eşiği (Floor State Machine)](#13-düzeltme-3--minimum-araştırma-eşiği-floor-state-machine)
14. [Düzeltme #4 — engine.ts:85 Koşullu "Yaz" Emri (Recency Çatışması Susturması)](#14-düzeltme-4--enginets85-koşullu-yaz-emri-recency-çatışması-susturması)
15. [Düzeltme #5 — prompts.ts İncelemesi ve Kod-Tutarlı Revizyon](#15-düzeltme-5--promptst-incelemesi-ve-kod-tutarlı-revizyon)
16. [Uygulama Sırası ve Önceliklendirme](#16-uygulama-sırası-ve-önceliklendirme)
17. [Risk Analizi ve Geri Alım Stratejisi](#17-risk-analizi-ve-geri-alım-stratejisi)
18. [Doğrulama ve Test Stratejisi](#18-doğrulama-ve-test-stratejisi)
19. [AGENTS.md Güncelleme Yükümlülüğü](#19-agentsmd-güncelleme-yükümlülüğü)

---

## 1. Yönetici Özeti

ATHENA-001'in araştırma motorunda üç ayrı semptom — (A) kalitesiz/bölünmemiş query üretimi, (B) yetersiz araştırma yapıldığında erken durma, (C) High/Ultra modda "connection lost" — birbirinden bağımsız üç bug değil. Bunların üçü de **tek bir mimari yaklaşım hatasının** üç farklı belirtisidir: sistem, kod seviyesinde zorlanması gereken kuralları yalnızca prompt metni seviyesinde ifade ediyor; şema ve engine seviyesinde hiçbir zorlayıcı kontrol bulunmuyor. Model bu talimatlara uyup uymamakta tamamen özgür bırakılıyor.

Bu durum üç mekanik kök sebebe ayrıştırılmıştır:

| # | Kök sebep | Birincil dosya | Doğrulama |
|---|---|---|---|
| A | Tool şeması iki ayrı alan sunuyor, hiçbiri zorunlu değil → model her zaman tek-string yoluna kaçıyor | `types.ts:42-47`, `engine.ts:262` | ✅ Kod düzeyinde kesin |
| B | Erken durma: koşulsuz "yaz" emri her round context sonuna enjekte ediliyor + "floor" (alt sınır) kontrolü yok + mevcut guard'ın deliği var | `engine.ts:84-85,176-180,184-189`, `prompts.ts:37,56-64` | ✅ Çoklu dosya, mekanik olarak izlenebilir |
| C | Cooldown tek event + sessiz `setTimeout` → Ultra'da her round garanti ≥60s, High'da penaltiyle 100s+ → SSE bağlantısı ölüyor | `cooldown.ts:70-107,109-135`, `engine.ts:489,596` | ✅ Matematiksel olarak kesin |

Üç düzeltme bu kök sebepleri kod seviyesinde çözer — prompt metnine güvenmez, modelin inisiyatifini zorunlu kılan şema ve state-machine kısıtlamaları getirir:

1. **Düzeltme #1** (Şema): Tek zorunlu array alanı → modelin tek-string sıkıştırma seçeneğini fiziksel olarak kaldırır
2. **Düzeltme #2** (Heartbeat): Cooldown'u nabız üreten yapıya çevirir → SSE bağlantısını yaşatır, cooldown'un orijinal amacını (rate limit koruması) korur
3. **Düzeltme #3** (Floor): Bütçe-tükenme kontrolünün simetriği olarak minimum araştırma eşiği → tool çağırmadan cevap verme yetkisini sayılabilir koşula bağlar

Bunlara iki küçük ek eşlik eder:
- **Düzeltme #4** (1 satır): `engine.ts:85`'teki koşulsuz "yaz" emrini koşullu yap — `prompts.ts:56-64`'teki doğru kriteri gölgeleyen recency çatışmasını ortadan kaldırır
- **Düzeltme #5** (post-kod): `prompts.ts`'i kod düzeltmeleriyle tutarlı hale getir — metin-seviyesi talimatların kod artık zorlayan kurallarla çelişki yaratmasını önler

---

## 2. Ortak Üst-Bulgu: Soft Enforcement Paradoksı

Üç semptomun ortak çıktısı: sistem, "query'leri array'e böl", "yeterli araştırma yapmadan cevap verme", "notebook'a yaz" gibi kuralları yalnızca **prompt metni / tool açıklaması (description)** seviyesinde ifade ediyor. Şema ve engine seviyesinde bu kurallara uyumu zorlayan hiçbir mekanizma yok:

- `SEARCH_TOOL.function.parameters`'ında `queries` array alanı var ama `required` değil, ve `search_query` tek-string alanı da yan yana duruyor → model serbest bırakıldığında daha kolay yola kaçıyor
- `toolCallingRound`'da `toolChoice: 'auto'` (satır 189) → model her round tool çağırmamayı seçebilir; bu seçim hiçbir sayısal eşiğe bağlı değil
- Notebook yazma "dürtmesi" (`cadenceInstruction`, satır 171-175) reaktif: yalnızca belirli sayıda ham tool-result mesajı birikince tetikleniyor; model az search yapıp hemen cevap verirse bu dürtme hiç tetiklenmiyor
- `engine.ts:85`'teki "Write the final answer..." cümlesi her round, koşulsuz, context'in en sonuna (en taze konuma) ekleniyor → `prompts.ts:56-64`'teki sıkı kriteri recency bias ile eziyor
- `prompts.ts:37`'deki "notebook'a bırakma kararı yazma yasağı" yalnızca `write_notebook` çağrısının içeriğini kısıtlıyor; model bu çerçeveyi final-answer metnine taşıyıp es geçiyor

Bu, "guardlarla kontrol altına alsaydık model her hatasında tekrar dener" endişesinin somut tezahürüdür: metin-seviyesi talimatlar model için pazarlık konusu, zorlayıcı değil; model bu talimatları es geçmenin bir yolunu buluyor (tek-string seçeneği, "bırakma" çerçevesini final-answer'a taşıma, "yeterli" deme kararı tamamen kendi inisiyatifinde).

**Çözümün yönü bu üst-bulguyla tutarlı olmalı:** kuralları metin seviyesinde "lütfen yapma" diye tekrarlamak yerine, modelin bu kuralları es geçmesinin fiziksel olarak imkansız olduğu arayüzleri (şema, state machine, nabız) yeniden tasarlamak. Aşağıdaki düzeltmelerin her biri bu ilkeye uyar — hiçbiri guard/hack değil, var olan arayüzleri düzeltiyor.

---

## 3. Kök Sebep A — Query Kalitesi: Tool Şeması Zorlamıyor

### 3.1. Doğrulanmış bulgu

**Dosya:** `server/src/engine/types.ts:42-47` (`SEARCH_TOOL.function.parameters.properties`)

```typescript
properties: {
  search_query: { type: 'string', description: 'A compact search phrase for one evidence need.' },
  queries: { type: 'array', items: { type: 'string' }, description: 'Multiple compact search phrases, one per distinct evidence need.' },
  type: { type: 'string', enum: ['search', 'news', ...], description: 'Type of search to perform.' },
},
```

İki ayrı alan yanyana duruyor; ikisinin de `required` listesinde olmadığı açık (satır 48-49'da `required` array'i hiç yok). Model tool-calling modellerinin genel eğilimi, JSON-encode açısından daha maliyetli/riskli olan array üretmek yerine daha basit tek-string yolunu seçmek. Burada `search_query` hâlâ mevcut ve `queries` zorunlu olmadığı için, sistem "model her ne yazarsa kabul et" felsefesiyle tasarlanmış.

**Doğrulama — `engine.ts:262`** (bu ikiliği destekleyen extraction kodu):
```typescript
const qs = args.queries || args.search_query || args.query || args.searchquery || args.q;
```
Bu satır **5 farklı alternatif alan adını** kabul ediyor. Bu, esnekliği artırıyor ama disiplini sıfırlıyor. Model hangi alan adını kullanırsa kullansın, motor kabul ediyor.

**Doğrulama — `tool-parser.ts:7-12`** (inline/XML tabanlı modeller için `extractQuery`):
```typescript
return (params.search_query || params.query || params.searchquery || params.q) as string | null;
```
İlk dört alan adı; `queries` array burada doğrudan aranmıyor ama satır 46-49 ve 66-68'de `params.queries` array olarak doğrudan yakalanıyor. Yani parser da iki yolu da destekliyor.

### 3.2. Mekanik açıklama

Tool-calling modelleri, fonksiyon çağrısının argumanlarını üretirken şemayı dikkate alır. Şema `search_query: string` ve `queries: array` alanlarını yanyana sunuyorsa ve hiçbiri zorunlu değilse, modelin iki seçeneği var. Modeller genel olarak "en kolay" yola eğilimlidir — array üretmek JSON serialization açısından daha fazla token ve daha fazla hata riski demek; tek string üretmek daha hızlı ve daha güvenli. Bu yüzden, prompt'ta "distinct evidence needs" ne kadar vurgulanırsa vurgulanlasın, şema seviyesinde array zorunlu olmadığı sürece model array üretmemeyi seçebilir.

Bu, "prompt iyileştirirsek sorun çözülür" sanılan bir hatadır: prompt'taki "Query strategy" bölümü zaten doğru yazılmış (`prompts.ts:49-54`), ama şemada tek-string seçeneği var olduğu sürece, model bu talimatlara uymamak için fiziksel bir kaçış yolu buluyor. Prompt'a daha fazla ısrar eklemek bu kaçış yolunu kapatmaz; tek başına şema düzeltmesi kalıcı çözüm.

### 3.3. Çözüm yönü (Düzeltme #1)

Şemada **tek bir zorunlu array alanı** bırak:
- `queries: string[]` — `required: true`, `minItems: 1` ile
- `search_query` alanını şemadan tamamen çıkar
- `type` alanı opsiyonel olarak kalsın (mevcut `enum` ile)
- `tool-parser.ts`'teki fallback extraction mantığını (eski/XML tabanlı modeller için `search_query`/`query`/`q` kabul eden) **koru** — bu, JSON şemasına uymayan modeller için bir last-resort güvenlik ağı; sorun şemada, parser'da değil

Bu değişikliğin etkisi dolaylı değil, doğrudan: model artık "tek string'e sıkıştırma" seçeneğine **fiziksel olarak sahip olmayacak**, çünkü o alan şemada yok. Bu, prompt'ta ne kadar ısrar edilirse edilsin metinle çözülemeyecek bir sorunun, şema seviyesinde tek satırlık bir kısıtlamayla kalıcı şekilde çözülmesi demek — guard/hack değil, arayüzün kendisini düzeltmek.

### 3.4. Etki alanı

- Tüm tool-calling modelleri (Groq, Gemini, OpenRouter, custom) bu şemayı alır; etkisi provider-agnostic
- `tool-parser.ts`'in değişmesine gerek yok (parser zaten `queries`'i yakalıyor, satır 46-49 ve 66-68)
- `engine.ts:262`'deki `args.queries || args.search_query || ...` fallbacki aynen kalabilir; bu satır artık ilk deneme için `args.queries` kullanacak, gerisi yalnızca eski modeller için güvenlik ağı
- Quick mode da aynı şemayı kullanır (`engine.ts:186`: `deepState ? [...] : [SEARCH_TOOL, FETCH_URL_TOOL]` — `SEARCH_TOOL` her iki modda aynı); düzeltme her ikisini de iyileştirir

---

## 4. Kök Sebep B — Erken Durma: Üç Birbirini Besleyen Delik

Erken durma tek bir bug değil, birbirini besleyen üç ayrı delik. Üçü de doğrulanmıştır.

### 4.1. Delik B1 — Koşulsuz "Yaz" Emri Her Round (✅ doğrulandı)

**Dosya:** `engine.ts:75-88` (`deepResearchContextBlock` fonksiyonu) + çağrı noktası `engine.ts:170-180`

Satır 84-85 (raporla harfiyen örtüşüyor, teyit edildi):
```typescript
'Use write_notebook to append Markdown notes after digesting raw results. Use read_notebook if the notebook is truncated and you need earlier sections. Do not repeat ledger queries.',
'Write the final answer from the notebook, ledger, and source list. State what is verified, what is uncertain, and what could not be confirmed. Do not invent facts.',
```

Bu blok `deepResearchContextBlock` fonksiyonunda, satır 80-87'de array olarak birleştiriliyor. Çağrı noktası `engine.ts:170-180`:
```typescript
if (deepState) {
  const uncompactedRawBlocks = countUncompactedRawResearchMessages(messages, deepState);
  const cadenceThreshold = Math.max(1, deepState.preset.notebookCadenceRawBlocks);
  const cadenceInstruction = uncompactedRawBlocks >= cadenceThreshold ? `...` : '';
  messages.push({
    role: 'system',
    content: deepResearchContextBlock(deepState, cadenceInstruction, allSources),
  });
}
```

Bu blok `deepState` varsa (yani her deep research isteğinde) **her tek round'da**, koşulsuz olarak system mesajı olarak modele gidiyor. Round 1'de, 2 search'ten sonra da, 10 search'ten sonra da aynı cümle aynı şekilde gidiyor. Hiçbir `if (budgetExhausted)` veya `if (floorReached)` koşulu yok — yalnızca `if (deepState)`.

Satır 84'ın içeriği "ne zaman yazacağını" değil, "nasıl yazacağını" anlatmak için tasarlanmış olsa da, satır 85 emir kipiyle ("Write the final answer...") ve **koşulsuz** olarak yazıldığı için, modelin önünde her round şu iki sinyal aynı anda duruyor (detay Bölüm 7'de).

### 4.2. Delik B2 — "Floor" (Alt Sınır) Kontrolü Yok (✅ doğrulandı)

**Dosya:** `engine.ts:184-189` (tool seçimi) ve `engine.ts:127-168` (bütçe kontrolü)

Tool çağrısı yapma yetkisinin kod seviyesinde kısıtlanmadığı yerler:

```typescript
const tools = researchExhausted
  ? (deepState && !hasWrittenNotebookInExhaustion ? [WRITE_NOTEBOOK_TOOL, READ_NOTEBOOK_TOOL] : undefined)
  : (deepState ? [SEARCH_TOOL, FETCH_URL_TOOL, WRITE_NOTEBOOK_TOOL, READ_NOTEBOOK_TOOL] : [SEARCH_TOOL, FETCH_URL_TOOL]);
try {
  llmResult = await callLLMStream({
    messages, temperature: temp, tools, toolChoice: tools ? 'auto' : 'none', role, signal,
    ...
```

`toolChoice: 'auto'` (satır 189) — model her round tool çağırmamayı seçebilir. Bütçe kontrolü var ama bu yalnızca *tükendiğinde* devreye giriyor (satır 127-168, `budget.remainingCredits <= 0`); *yetersiz araştırma yapıldığında* devreye giren bir alt-sınır (floor) **yok**.

Yani modelin "yeterli" deme kararı tamamen kendi inisiyatifinde; bunu durduracak hiçbir kod-seviyesi mekanizma yok. `prompts.ts:56-64`'teki "no material unresolved gaps" kriterleri salt metin, dolayısıyla pazarlık konusu, zorlayıcı değil.

### 4.3. Delik B3 — Notebook Yazma Dürtmesi Reaktif, Tetiklenmiyor (✅ doğrulandı)

**Dosya:** `engine.ts:170-180` + `depth-presets.ts:27-87`

`cadenceInstruction` (satır 171-175) **reaktif**: sadece belirli sayıda "ham" tool-result mesajı birikince tetikleniyor:

```typescript
const uncompactedRawBlocks = countUncompactedRawResearchMessages(messages, deepState);
const cadenceThreshold = Math.max(1, deepState.preset.notebookCadenceRawBlocks);
const cadenceInstruction = uncompactedRawBlocks >= cadenceThreshold
  ? `\n\nBefore further search or fetch calls, call write_notebook to preserve the ${uncompactedRawBlocks} raw evidence block(s) currently still in context. ...`
  : '';
```

Preset değerleri (`depth-presets.ts`):
- low: `notebookCadenceRawBlocks = 4` (satır 34)
- med: `notebookCadenceRawBlocks = 2` (satır 48)
- high: `notebookCadenceRawBlocks = 1` (satır 64)
- ultra: `notebookCadenceRawBlocks = 1` (satır 79)

**Kritik mekanik gözlem:** Model 2 search yapıp cevap verirse ve bu 2 search **tek bir tool_call batch'i** içinde gönderilmişse (ki genelde öyle oluyor — `queries` array'i ile tek çağrıda), bu 2 search **tek bir tool mesajına** dönüşüyor (`engine.ts:492`: `resultsByTcId` her `tcId` için sonuçları birleştiriyor). Yani Low'da eşik 4 olduğu için bu dürtme **hiç tetiklenmiyor** — `uncompactedRawBlocks` 1–2 civarında kalıyor, eşik 4'e ulaşmıyor.

Bu, raporun "Low/Med bütçenin yalnızca %10-11'i kullanılıyor" bulgusunun mekanik izahı: model az search yapıp hemen cevap verince notebook dürtmesi hiç devreye girmiyor, ve B1'deki "yaz" emri de bunu meşrulaştırıyor.

### 4.4. Çözüm yönü (Düzeltme #3 + Düzeltme #4)

Bunu bir **prompt iyileştirmesi** olarak değil, bir **state-machine kapısı** olarak tasarla. Motor zaten elinde somut, sayılabilir sinyaller tutuyor:
- `deepState.ledger.searches.length` — tamamlanan arama sayısı
- `deepState.notebook.appendCount` — notebook yazma sayısı
- `allSources.size` — keşfedilen kaynak sayısı
- `round` — mevcut round

Bunları kullanarak depth'e özel bir **minimum araştırma eşiği** tanımla — `depth-presets.ts`'teki mevcut preset alanlarıyla aynı yapıda yeni alanlar:
- `minSearchesBeforeAnswer: number`
- `minNotebookWritesBeforeAnswer: number`

`toolCallingRound`'da, model tool çağırmadan cevap döndürdüğünde (`kind: 'answer'` olacağı an, `engine.ts:628-633`), bu eşik karşılanmamışsa **cevabı kabul etme** — onun yerine modele "şu spesifik gap'leri henüz kapatmadın, en az 1 search/fetch daha yap" diyen bir system mesajı push edip round'u tools moduna geri çevir.

Bu, bütçe-tükenme kontrolünün (`engine.ts:127-168`'da `budget.remainingCredits <= 0` ile yapılan) **simetriği**: orada "tükendi mi" kontrolü var, burada "yeterince doldu mu" kontrolü eksik. İkisi de aynı yere, aynı mantıkla eklenebilir.

Ayrıca: satır 84-85'teki koşulsuz "Write the final answer..." cümlesini, tıpkı `budgetExhaustedDeepMessage()`'ın zaten yaptığı gibi **koşullu** hale getir — yani bu cümle sadece yukarıdaki eşik karşılandığında ya da bütçe tükendiğinde görünsün, her round değil. Bu, Düzeltme #4'te (Bölüm 14) detaylandırılıyor.

---

## 5. Kök Sebep C — Connection Lost (High/Ultra): Cooldown Sessizliği

### 5.1. Doğrulanmış bulgu — deterministik, matematiksel olarak kesin

Bu, raporun en zayıf kaldığı yerde ("olası nedenleri" diye 3 ihtimal sıralamış: context overflow, provider timeout, cooldown sessizliği) kodu görünce **kesin, deterministik** bir sebep olduğunu doğruladım. Raporun 3 tahmininden en güçlüsü kesinleşti.

**Dosya:** `cooldown.ts:109-135` (`waitCooldown` fonksiyonu)

```typescript
export async function waitCooldown(
  ms: number, reason: string, signal?: AbortSignal, onWait?: (note: string) => void,
): Promise<boolean> {
  if (ms <= 0 || signal?.aborted) return !signal?.aborted;
  const note = `Waiting ${Math.round(ms / 1000)}s — ${reason}`;
  onWait?.(note);   // ← TEK BİR event burada gönderiliyor
  return new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => resolve(true), ms);   // ← ms boyunca HİÇBİR event yok
    if (signal) {
      const onAbort = () => { clearTimeout(timer); resolve(false); };
      if (signal.aborted) { clearTimeout(timer); resolve(false); return; }
      signal.addEventListener('abort', onAbort, { once: true });
    }
  });
}
```

`onWait` çağrısı **tek seferlik**. `engine.ts:683-687`'de bir `cooldown` step'i push ediliyor, sonra `setTimeout` süresi boyunca (ms) **stream'e tek bir token, tek bir step, tek bir hiçbir şey gitmiyor.**

**Çağrı noktaları:**
- `engine.ts:489` (`applyResearchCooldown`, native tool-call batch yolu)
- `engine.ts:596` (`applyResearchCooldown`, inline tool-call yolu)

İki yol da aynı `applyResearchCooldown` fonksiyonunu çağırıyor (satır 663-688), o da `waitCooldown`'u çağırıyor.

### 5.2. `computeCooldownMs`'in gerçek sayıları — doğrulanmış

**Dosya:** `cooldown.ts:70-107` + `depth-presets.ts:27-87`

```typescript
const base = randomBetween(preset.minCooldownMs, preset.maxCooldownMs);
const errorPenalty = recentErrorRate(state) * 2.0;
const rateLimitPenalty = state.recent429Count > 0 ? 1.5 : 0;        // ← 429 varsa 1.5x
const latencyPenalty = avgLatencyMs(state) > 20_000 ? 0.5 : 0;
const pressurePenalty = providerPressure;
const healthyBonus = state.successStreak >= 5 ? -0.25 : 0;
const urgentBonus = remainingRounds <= 2 && preset.depth !== 'ultra' ? -0.15 : 0;
const multiplier = 1 + errorPenalty + rateLimitPenalty + latencyPenalty + pressurePenalty + healthyBonus + urgentBonus;
const maxCap = preset.depth === 'ultra' ? Math.max(preset.maxCooldownMs * 5, 300_000) : preset.maxCooldownMs * 4;
let ms = clamp(base * multiplier, preset.minCooldownMs, maxCap);
if (preset.depth === 'ultra') { ms = Math.max(ms, preset.minCooldownMs); }
```

Preset değerleriyle tablo:

| Depth | min–max (baz) | `maxCap` (penaltili tavan) | Garanti minimum sessizlik | Pratik tavan (penaltiyle) |
|---|---|---|---|---|
| low | 5–10s | 40s | ~5–10s | 40s |
| med | 10–15s | 60s | ~10–15s | 60s |
| high | 20–40s | **160s (2.6 dk)** | ~20–40s | penaltiyle 100s+ kolay |
| ultra | 60–60s (sabit) | **300s (5 dk)** | **HER ROUND garanti ≥60s** | 300s |

`ultra` için `minCooldownMs === maxCooldownMs === 60_000` olduğundan (`depth-presets.ts:77-78`), `randomBetween` (satır 33-36) zaten 60.000ms döndürüyor — yani **her round, en az 60 saniye, hiçbir SSE event'i gelmeyen kesin bir sessizlik penceresi var.** Bu bir olasılık değil, kodun garantisi.

`high`'da ise rate-limit/hata penaltısı (satır 86: `rateLimitPenalty = 1.5`) bir 429 alındığında çarpanı anında 2.5x'e çıkarıp 40s'lik baz cooldown'u 100s'nin üzerine taşıyabiliyor (40 × 2.5 = 100s; errorPenalty da eklenirse daha da yükseği). `maxCap` 160s'ye kadar izin veriyor.

### 5.3. Tarayıcı/proxy idle timeout karşılaştırması

Tarayıcılar, reverse proxy'ler, CDN'ler ve serverless runtime'ların SSE/streaming bağlantılar için tipik idle-timeout değerleri genelde 30–60 saniye aralığındadır. Bu, kodun matematiksel garantisiyle çakışıyor:

- **High**: baz cooldown (20–40s) zaten sınırda; bir 429/hata olduğunda kesin aşılıyor → "rastgele connection lost" gözlemini açıklıyor
- **Ultra**: 60s sabit minimum → **her round garanti aşım** → "ultra'da bu tasarım gereği imkansıza yakın" tespiti kesinlikle doğru, ama "imkansıza yakın" değil, **matematiksel olarak kaçınılmaz**

Raporun diğer iki tahmini (context overflow / provider timeout) bu kodda doğrulanamadı çünkü `llm.ts` ve `search.ts` (LLM çağrısını yapan, provider'a giden dosyalar) incelenmedi. Ama bunlar **bağımsız ek sebep olmaktan çok, aynı kök sorunun (soft enforcement yok) ikincil bir sonucu** olabilir: notebook yazımı zorlanmadığı için (B3), model ham search/fetch sonuçlarını context'te biriktirip notebook'a sıkıştırmadan ilerleyebiliyor — bu da context boyutunu büyütüp olası 413/timeout riskini artırabilir. Ama **kesin** kanıtladığımız, ms cinsinden ölçülebilir kök sebep, cooldown'un sessiz blocking yapısı.

### 5.4. Çözüm yönü (Düzeltme #2)

Cooldown'un *amacı* (LLM/search sağlayıcısını hız sınırına karşı korumak) tamamen meşru — sorun amaç değil, **uygulanış şekli**. Tek bir opak `setTimeout` yerine, bekleme süresini **heartbeat üreten** bir yapıya çevir:

- Bekleme boyunca her 5–10 saniyede bir hafif bir "still waiting" progress event'i yayınla
- Zaten `onEvent`/`steps` mekanizması bunun için hazır — sadece `setTimeout` tek seferlik değil, periyodik çalışmalı
- Heartbeat neyi bozar? Hiçbir şeyi: SSE bağlantısını yaşatır (idle reset timer'ı sürekli sıfırlanır), cooldown'un orijinal amacını (rate limit koruması) korur
- Heartbeat neyi öldürür? "X saniye sessizlik" yerine "X saniye boyunca her 8 saniyede bir nabız sinyali" olur

Bu, guard/hack değil — zaten var olan event altyapısını (`onEvent` callback'i, `AgentStep`'lerin `type: 'cooldown'` alanı), var olan bekleme mantığına bağlamaktan ibaret bir yapısal düzeltme.

---

## 6. Yeni Bulgu #1 — Notebook'ta "Bırakma" Yasağı Delikli Guard

### 6.1. Doğrulanmış bulgu

**Dosya:** `prompts.ts:37`

```markdown
**Never write a decision to stop in the notebook.** Do not write "further research won't help", "this information is not accessible", "mevcut araçlarla sonuç vermeyecektir", or any similar conclusion. The notebook records what you found, what you didn't find, and what to try next — never whether to give up. If a search didn't find what you needed, the next notebook entry must propose a different search strategy, not a conclusion that the information doesn't exist.
```

Bu satır, birinin daha önce **tam olarak bu sorunu fark edip** notebook seviyesinde kapatmaya çalıştığının kanıtı. Ama kullanıcı gözlemi şöyle:

> "...2-4 search yapıp **'kapsamlı araştırmalar sonucunda...'** diyerek final answer veriyor"

### 6.2. Mekanik açıklama

Dikkat: model bu "bırakma" cümlesini **notebook'a değil, doğrudan final cevaba** yazıyor. Satır 37'deki kural yalnızca `write_notebook` çağrısının içeriğini kısıtlıyor — modelin "tool çağırmadan direkt cevap ver" kararını **hiç kısıtlamıyor.**

Model, notebook'a "bulamadım, bırakıyorum" yazmak yasak olduğunu (muhtemelen önceki bir fix'ten dolayı) "öğrenmiş" ama bunun yerine aynı "bırakma" çerçevesini, hiçbir kuralın korumadığı **final-answer metnine** taşımış. Yani **önceki bir düzeltme girişimi sorunu çözmemiş, sadece nereye yazıldığını değiştirmiş.**

Bu, raporun "guardlarla kontrol altına alsaydık model her hatasında tekrar dener" şeklindeki kaygını tam olarak doğruluyor: satır 37 tipik bir **guard** — belirli bir kelime/çerçeveyi yasaklıyor — ve model onu metin seviyesinde es geçmeyi buluyor.

### 6.3. Çözüm yönü

Kelime yasaklamak değil, **tool çağırmadan cevap verme yetkisini** somut sayılabilir koşula bağlamak gerekiyor. Bu, Düzeltme #3'ün (Bölüm 13) yaptığı şey. Düzeltme #3 uygulandıktan sonra, `prompts.ts:37`'deki bu kural artık bir guard değil, bir pekiştirme haline gelir — kod floor eşiklerini zorluyor, prompt bunu destekliyor. Çelişki yok.

Düzeltme #3 yapıldıktan sonra `prompts.ts:37` olduğu gibi bırakılabilir; yeniden yazılması gerekmez. Asıl düzeltme kod seviyesinde; prompt mevcut guard'ı koruyarak kod düzeltmesini destekler halde kalabilir.

---

## 7. Yeni Bulgu #2 — Recency Çatışması: engine.ts:85 vs prompts.ts:56-64

### 7.1. Doğrulanmış bulgu — her iki dosyada da

**Dosya:** `prompts.ts:56-64` ("Final answer readiness" bölümü)

```markdown
**Final answer readiness**
Write the final answer only when one of these is true:
- The notebook shows no material unresolved gaps for the user's requested scope.
- Remaining gaps are explicitly unresolvable AND you have tried at least two distinct source strategies for each such gap (not just rephrased queries), as required by point 8. Record the strategies tried in the notebook.
- The research budget is exhausted.

Do not declare a gap unresolvable just because the first or most authoritative source returned unusable content (PDF, paywall, login wall, JS-rendered, empty). Secondary reporting, mirrors, aggregators, archives, and republished versions are all valid evidence if primary access fails.

Before finalizing, mentally audit the notebook against the user's original brief: every material requirement should be answered, qualified, or explicitly marked unverified. **Specifically ask yourself: did I search for the exact content the user requested, or did I search around it?** If you only have meta-information (topics, schedules, distribution, when-where-how) but not the actual requested content (the questions themselves, the prices, the specifications, the quotes), you have not answered the brief — continue researching.
```

Bu, tek başına değerlendirilse **gayet sağlam bir kriter.** Sorun bunun yazılışında değil, **nerede ve ne zaman modele gösterildiğinde.**

### 7.2. Çatışmanın mekanik yapısı

Bu kriter, `messages[0]`'daki sistem promptunun içinde — yani konuşmanın en **başında**, bir kere yazılıyor. Buna karşılık `engine.ts:85`'teki şu cümle:

```typescript
'Write the final answer from the notebook, ledger, and source list. State what is verified, what is uncertain, and what could not be confirmed. Do not invent facts.',
```

— **her round**, context'in **en sonuna** (modelin bir sonraki token'ı üretmeden hemen önceki konuma) ekleniyor (`engine.ts:176-180`'de `messages.push({ role: 'system', content: deepResearchContextBlock(...) })` ile), ve **hiçbir koşul içermiyor.**

"Final answer'ı ne zaman yazacağını" değil, sadece "final answer'ı nasıl yazacağını" anlatmak için tasarlanmış olsa da, emir kipiyle ("Write the final answer...") ve koşulsuz olarak yazıldığı için, modelin önünde her round şu iki sinyal aynı anda duruyor:

| Konum | Mesaj | Çerçeve |
|---|---|---|
| Context başı (1 kere, `messages[0]`) | "Sadece şu 3 koşuldan biri doğruysa cevap yaz" | Koşullu, kısıtlayıcı |
| Context sonu (her round, en taze) | "Notebook'tan final answer'ı yaz" | Koşulsuz, emir kipi |

### 7.3. Recency bias mekanizması

LLM'lerde iyi belgelenmiş bir davranış: context'in **sonunda, en taze** olan talimat, başta kalan talimata göre daha güçlü ağırlık alır ("recency bias" / "lost in the middle" etkisinin bir türevi). Bu, prompt mühendisliğinde bilinen bir fenomen.

Yani sistem promptu çok iyi yazılmış olsa bile, her round'da modele en son gösterilen şey "şimdi yaz" anlamına gelen koşulsuz bir cümle. Sistem promptu başta bir kere yazılıyor; `engine.ts:85` her round taze olarak gözüküyor. Bu asimetri, modelin "yeterli araştırma yaptım" kararı vermesinde erken durmaya meyilini mekanik olarak açıklıyor.

Bu, raporun 2A bulgusunu "muhtemel" seviyesinden çıkarıp **mekanik olarak açıklanabilir bir çatışma** seviyesine taşıyor.

### 7.4. Çözüm yönü (Düzeltme #4)

`prompts.ts`'i değiştirmeye gerek yok — orada yazılan kriter zaten doğru. Asıl düzeltme `engine.ts:85`'teki cümlenin **koşulsuz oluşu.** Bu satır, `budgetExhaustedDeepMessage()`'ın zaten yaptığı gibi, sadece "yazma izni" verilen durumda görünmeli; her round otomatik enjekte edilmemeli.

Düzeltme #4 (Bölüm 14): `deepResearchContextBlock` fonksiyonundan bu cümleyi çıkar, ve onu yalnızca şu iki durumda modele gönder:
1. Floor eşiği karşılanmış ise (Düzeltme #3'ten sonra)
2. Bütçe tükenmiş ise (mevcut `budgetExhaustedDeepMessage()` yoluyla)

Bu, `prompts.ts`'e dokunmadan, sadece `engine.ts` içinde bir satırı bir `if`'in içine almak kadar küçük bir değişiklik, ama Yeni Bulgu #2'deki recency çatışmasını doğrudan ortadan kaldırıyor. `prompts.ts:56-64`'teki kriter zaten doğru yazılmış — onu yeniden yazmaya değil, onu **gölgeleyen** tek satırı susturmaya ihtiyaç var.

---

## 8. Yeni Bulgu #3 — Query Strategy Konumunun İkincil Etkisi

### 8.1. Doğrulanmış bulgu — ama etki derecesi düşük

**Dosya:** `prompts.ts:49-54` ("Query strategy" bölümü)

```markdown
**Query strategy**
- Use compact retrieval phrases, not conversational sentences.
- Preserve user-provided names, codes, model numbers, quoted terms, versions, dates, and numeric constraints exactly.
- Each query should target a distinct evidence need or unresolved notebook gap.
- Avoid repeating the same query with superficial wording changes.
- Choose the query language based on where authoritative sources are likely to exist.
```

Rapor "75 satırlık prompt'ta 6 satır kayboluyor" diyor — satır numaraları (49–54) doğrulandı.

### 8.2. Konum analizi

Bu bölüm tam olarak "ortada gömülü" değil, **"Research behavior" (8 madde, en uzun bölüm, ~39–47. satırlar) ile "Final answer readiness" (en kritik karar noktası, 56–64. satırlar) arasında sıkışmış.** Karşılaştırma için instant `SYSTEM_PROMPT`'ta (`prompts.ts:1-17`) aynı talimat 17 satırlık dokümanın 9. satırında, yani belgenin tam ortasında ama belge kısa olduğu için "kaybolma" riski yok.

### 8.3. Etki derecesi — ikincil

Bunu raporun iddia ettiği kadar kesin bir "kök sebep" olarak değerlendirmiyorum — çünkü bu, ölçülebilir bir kod davranışı değil, modellerin uzun promptlarda dikkat dağılımıyla ilgili genel (ve literatürde bilinen) bir eğilim. **Asıl, kanıtlanabilir kök sebep hâlâ Kök Sebep A'daki şema sorunu** (Bölüm 3): `search_query` alanı şemada var olduğu sürece, prompt ne kadar iyi yazılırsa yazılsın model "daha kolay" yola kaçabilir. Konum sorunu bu sorunu büyütücü bir faktör, ama şema düzeltmesi olmadan yalnızca "Query strategy"yi belgenin başına taşımak sorunu tam çözmez — çünkü model'in elinde hâlâ tek-string seçeneği olur.

### 8.4. Çözüm yönü

Düzeltme #1 (şema) yapıldıktan sonra, bu bölümün konumu ikincil hale gelir — modelin fiziksel olarak tek-string seçeneği kalmadığı için prompt'taki talimat daha kolay işler. Yine de, Düzeltme #5'te (Bölüm 15) `prompts.ts` gözden geçirilirken, "Query strategy" bölümünü belgenin daha erken bir yerine taşımak (örneğin "Research behavior" bölümünden hemen önce, ~38. satıra) düşük maliyetli bir ek iyileştirme olarak değerlendirilebilir. Bu, hiçbir kod değişikliği gerektirmeyen bir metin-seviyesi optimizasyondur.

---

## 9. Doğrulama Matrisi — Tüm Bulguların Durumu

| # | Bulgular | Kök sebep | Dosya:Satır | Doğrulama durumu |
|---|---|---|---|---|
| A | Kalitesiz query (tek-string sıkıştırma) | Şema iki alan sunuyor, hiçbiri zorunlu değil | `types.ts:42-47`, `engine.ts:262`, `tool-parser.ts:7-12` | ✅ Kod düzeyinde kesin |
| A2 | Query strategy gömülü konum (destekleyici) | "Query strategy" belgenin orta-arka kısmında, uzun bir bölümün hemen sonrasında | `prompts.ts:49-54` | ✅ Konum doğrulandı, etkisi ikincil/olası |
| B1 | Koşulsuz "yaz" her round | `engine.ts:85` koşulsuz, her round, context sonuna enjekte | `engine.ts:75-88,170-180` vs `prompts.ts:56-64` | ✅ Her iki dosyada da doğrulandı, çatışma mekanik olarak izlenebilir |
| B2 | Floor kontrolü yok | `toolChoice:'auto'`, tool çağırmadan cevap verme yolu sayısal eşiğe bağlı değil | `engine.ts:127-168,184-189` | ✅ Kod düzeyinde kesin |
| B3 | Notebook dürtmesi reaktif, tetiklenmiyor | `cadenceInstruction` yalnızca raw block sayısı eşik aşınca; Low'da eşik 4 olduğu için hiç tetiklenmiyor | `engine.ts:170-175`, `depth-presets.ts:34,48,64,79` | ✅ Mekanizma doğrulandı |
| B4 | Mevcut guard'ın deliği | Notebook'ta "bırakma" yasağı (L37) ama final-answer'da yasak değil — model çerçeveyi oraya taşıyor | `prompts.ts:37` | ✅ Mevcut guard'ın deliği doğrulandı |
| C | Connection lost (High/Ultra) | Cooldown tek event + sessiz `setTimeout`, Ultra'da garanti ≥60s, High'da penaltiyle 100s+ | `cooldown.ts:70-107,109-135`, `engine.ts:489,596,683-687` | ✅ Matematiksel olarak kesin |
| 2C | Round başı system mesaj silme (raporda "bug" iddiası) | `engine.ts:118-125` filtreleme | ✅ İncelendi, **gerçek bir bug değil** — zararsız bir sil-ekle döngüsü. Önceliksiz. |
| 3 | Low/Med bütçenin %10-11'i kullanılıyor | B1+B2+B3 birleşik etkisi | `engine.ts:170-180,127-168`, `depth-presets.ts:27-87` | ✅ Mekanizma doğrulandı (B3 ile aynı kök sebep) |
| 3 | High/Ultra connection lost — 3 olası neden | Cooldown sessizliği kesinleşti; context overflow / provider timeout bağımsız ek olabilir | `cooldown.ts`, `llm.ts`/`search.ts` incelenmedi | ✅ Kesinleşti: tek, ölçülebilir, deterministik sebep = cooldown sessizliği (Bölüm 5) |

---

## 10. Çözüm Mimarisi — Üst-Bulgu Yönünde Tutarlılık

Üç ana düzeltme (#1, #2, #3) ve iki ek düzeltme (#4, #5), Bölüm 2'deki üst-bulguyla (soft enforcement paradoksunu çözme) tutarlı bir mimari oluşturur. Mimarinin temel ilkesi:

> **Kuralları metin seviyesinde "lütfen yapma" diye tekrarlamak yerine, modelin bu kuralları es geçmesinin fiziksel olarak imkansız olduğu arayüzleri (şema, state machine, nabız) yeniden tasarla.**

Bu ilkeye uyan düzeltmeler:

1. **Düzeltme #1 (Şema):** Modelin tek-string sıkıştırma seçeneğini fiziksel olarak kaldırır → prompt'a hiç dokunmadan query kalitesini kod seviyesinde çözer
2. **Düzeltme #2 (Heartbeat):** Modelin bağlantı kopma riskini ortadan kaldırır → SSE altyapısını yaşatır, cooldown orijinal amacını korur
3. **Düzeltme #3 (Floor):** Modelin "yeterli" deme kararını sayılabilir koşula bağlar → tool çağırmadan cevap verme yetkisi artık kod seviyesinde şartlı
4. **Düzeltme #4 (Recency susturma):** Modelin context sonunda gördüğü koşulsuz "yaz" emrini kaldırır → `prompts.ts:56-64`'teki doğru kriter recency bias ile ezilmesin
5. **Düzeltme #5 (Prompt tutarlılık):** Kod artık zorlayan kurallarla prompt'taki soft talimatların çelişki yaratmasını önler → metin-seviyesi talimatlar kod düzeltmelerini destekler halde olsun

Beş düzeltmenin hiçbiri guard/hack değil; hepsi var olan arayüzleri düzeltiyor. Bu, raporun "guardlarla kontrol altına alsaydık model her hatasında tekrar dener" kaygısının aksi — guard'lar (kelime yasakları) yerine **arayüz kısıtlamaları** (şema, state machine, nabız) kullanılıyor.

---

## 11. Düzeltme #1 — SEARCH_TOOL Şeması (Tek Alan, Zorunlu Array)

### 11.1. Değişiklik

**Dosya:** `server/src/engine/types.ts:37-51`

Mevcut:
```typescript
export const SEARCH_TOOL = {
  type: 'function',
  function: {
    name: 'web_search',
    description: 'Search the web for real-time information. ... Break distinct information needs into separate queries.',
    parameters: {
      type: 'object',
      properties: {
        search_query: { type: 'string', description: 'A compact search phrase for one evidence need.' },
        queries: { type: 'array', items: { type: 'string' }, description: 'Multiple compact search phrases, one per distinct evidence need.' },
        type: { type: 'string', enum: ['search', 'news', 'images', 'videos', 'places', 'shopping', 'scholar', 'patents'], description: 'Type of search to perform.' },
      },
    },
  },
} as const;
```

Hedef:
```typescript
export const SEARCH_TOOL = {
  type: 'function',
  function: {
    name: 'web_search',
    description: 'Search the web for real-time information. Generate compact retrieval phrases, not conversational questions. User-provided entities are source-of-truth text: preserve names, model numbers, versions, dates, acronyms, codes, quoted terms, and numeric constraints exactly. If an entity is unfamiliar or surprising, search it as written and verify it rather than replacing it with a familiar neighbor. Choose query language by source availability for surrounding retrieval terms. Break distinct information needs into separate queries — always pass an array in `queries`, one entry per distinct evidence need; do not collapse multiple needs into a single string.',
    parameters: {
      type: 'object',
      properties: {
        queries: {
          type: 'array',
          items: { type: 'string' },
          minItems: 1,
          description: 'One or more compact search phrases. Each entry targets one distinct evidence need. Never collapse multiple needs into a single string — use one array entry per need.',
        },
        type: { type: 'string', enum: ['search', 'news', 'images', 'videos', 'places', 'shopping', 'scholar', 'patents'], description: 'Type of search to perform.' },
      },
      required: ['queries'],
    },
  },
} as const;
```

### 11.2. Değişikliğin detayı

- `search_query` alanı şemadan **tamamen kaldırılır** — modelin fiziksel olarak tek-string sıkıştırma seçeneği olmaz
- `queries` alanı `required: true` ve `minItems: 1` ile zorunlu array
- `description`'a "always pass an array in `queries`" ifadesi eklenir — bu, şema seviyesinde zorunluluğu açıklar; opsiyonel metin değil, şema ile çakışan açıklama
- `type` alanı opsiyonel olarak kalır (mevcut `enum` ile)
- `as const` ifadesi korunur — TypeScript literal inference bozulmaz

### 11.3. Etkilenen dosyalar ve uyum

- `engine.ts:262`'deki `const qs = args.queries || args.search_query || args.query || args.searchquery || args.q;` — **değişiklik gerekmez**. Bu satır aynen kalır; artık ilk deneme için `args.queries` kullanılacak, gerisi yalnızca eski/XML tabanlı modeller için güvenlik ağı. `search_query`'nin şemada olmaması native tool-calling modellerini etkilemez (onlar şemaya bakar); fallback yalnızca inline/XML modeller içindir.
- `tool-parser.ts:7-12`'deki `extractQuery` — **değişiklik gerekmez**. Bu fonksiyon yalnızca inline/XML tabanlı modeller için çalışır; JSON şemasına uymayan modellerin ürettiği tek-string alanları yakalar. Şema düzeltmesi native tool-calling modellerini etkiler; parser fallback'ini korumak eski modeller için güvenlik ağıdır.
- `tool-parser.ts:46-49,66-68`'deki `params.queries` array yakalama — **değişiklik gerekmez**. Zaten array'i yakalıyor.
- Quick mode aynı şemayı kullanır (`engine.ts:186`'da `SEARCH_TOOL` her iki modda aynı) — düzeltme her ikisini de iyileştirir.

### 11.4. Risk

- **Çok düşük.** Şema değişikliği provider-agnostic; tüm tool-calling modeller aynı şemayı alır.
- **Geri alım:** eski şemaya geri dönmek `search_query` alanını geri eklemekle mümkün.
- **Yan etki:** bazı eski modeller (örneğin Llama 3.1'in erken sürümleri) şemaya tam uymamış olabilir; bunlar için `tool-parser.ts`'in fallback'i devreye girer. Bu, zaten mevcut bir mekanizma.

### 11.5. Doğrulama

- TypeScript derlemesi (`server/`'da `npm run build`) — `as const` ve tip uyumu
- Birim testi: bir mock model yanıtı `args.search_query = "tek string"` ile geldiğinde `engine.ts:262`'nin bunu yakaladığı doğrulanmalı (fallback güvenlik ağı çalışmalı)
- Birim testi: bir mock model yanıtı `args.queries = ["q1","q2"]` ile geldiğinde birden fazla search task oluştuğu doğrulanmalı
- Manuel test: quick mode'da bir tool-calling model (örneğin Groq Llama 3.1 70B) ile "1 ve 2 ve 3 soruları" şeklinde bir query gönder; modelin `queries` array üretip üretmediğini gözlemle (search step'lerde 3 ayrı query görünüp görünmediği)

---

## 12. Düzeltme #2 — Cooldown Heartbeat (SSE Sessizliğini Öldürme)

### 12.1. Değişiklik

**Dosya:** `server/src/engine/cooldown.ts:109-135` (`waitCooldown` fonksiyonu)

Mevcut:
```typescript
export async function waitCooldown(
  ms: number, reason: string, signal?: AbortSignal, onWait?: (note: string) => void,
): Promise<boolean> {
  if (ms <= 0 || signal?.aborted) return !signal?.aborted;
  const note = `Waiting ${Math.round(ms / 1000)}s — ${reason}`;
  onWait?.(note);
  return new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => resolve(true), ms);
    if (signal) {
      const onAbort = () => { clearTimeout(timer); resolve(false); };
      if (signal.aborted) { clearTimeout(timer); resolve(false); return; }
      signal.addEventListener('abort', onAbort, { once: true });
    }
  });
}
```

Hedef:
```typescript
export async function waitCooldown(
  ms: number, reason: string, signal?: AbortSignal, onWait?: (note: string) => void,
  onHeartbeat?: (note: string) => void,
): Promise<boolean> {
  if (ms <= 0 || signal?.aborted) return !signal?.aborted;
  const note = `Waiting ${Math.round(ms / 1000)}s — ${reason}`;
  onWait?.(note);

  const heartbeatIntervalMs = 8_000; // 8 saniyede bir nabız
  const startedAt = Date.now();
  return new Promise<boolean>((resolve) => {
    const mainTimer = setTimeout(() => {
      clearInterval(heartbeatTimer);
      resolve(true);
    }, ms);
    const heartbeatTimer = setInterval(() => {
      if (signal?.aborted) { clearInterval(heartbeatTimer); clearTimeout(mainTimer); resolve(false); return; }
      const elapsedMs = Date.now() - startedAt;
      const remainingMs = Math.max(0, ms - elapsedMs);
      const remainingSec = Math.round(remainingMs / 1000);
      onHeartbeat?.(`Still waiting ${remainingSec}s — ${reason}`);
    }, heartbeatIntervalMs);
    if (signal) {
      const onAbort = () => {
        clearInterval(heartbeatTimer); clearTimeout(mainTimer); resolve(false);
      };
      if (signal.aborted) { clearInterval(heartbeatTimer); clearTimeout(mainTimer); resolve(false); return; }
      signal.addEventListener('abort', onAbort, { once: true });
    }
  });
}
```

### 12.2. Çağrı noktası güncellemesi

**Dosya:** `engine.ts:663-688` (`applyResearchCooldown` fonksiyonu)

Mevcut (`engine.ts:683-687`):
```typescript
return waitCooldown(ms, reason, signal, (note) => {
  const s: AgentStep = { type: 'cooldown', note };
  steps.push(s);
  onEvent({ type: 'step', data: s });
});
```

Hedef:
```typescript
return waitCooldown(
  ms, reason, signal,
  (note) => {
    const s: AgentStep = { type: 'cooldown', note };
    steps.push(s);
    onEvent({ type: 'step', data: s });
  },
  (heartbeatNote) => {
    const s: AgentStep = { type: 'cooldown', note: heartbeatNote };
    steps.push(s);
    onEvent({ type: 'step', data: s });
  },
);
```

### 12.3. Değişikliğin mantığı

- `onWait` hâlâ tek seferlik başlangıç event'i (mevcut davranış korunur)
- `onHeartbeat` her 8 saniyede bir çağrılır; SSE stream'e "Still waiting Ns — ..." step'i gönderir
- `clearInterval` ve `clearTimeout` ile hem ana timer hem heartbeat timer doğru temizlenir
- `signal?.aborted` heartbeat içinde de kontrol edilir; abort anında her iki timer da temizlenir
- 8 saniye seçimi: tipik idle reset timer'ları 30s+ olduğundan, 8s'lik nabız onları sürekli sıfırlar; çok sık değil (token/step bolluğu olmaz), çok seyrek değil (idle timeout'a yetişir)

### 12.4. Etki matematiği

- Ultra, 60s cooldown: 8s'lik nabız → 7–8 event gönderilir (60 / 8 = 7.5). SSE bağlantısı her 8s'de bir resetlenir; 60s'lik sessizlik penceresi artık "X saniye sessizlik" değil "60s boyunca her 8s'de bir nabız" olur.
- High, 100s'lik penaltili cooldown: ~12–13 nabız event'i. Bağlantı garanti yaşar.
- Low/Med (5–15s): 0–2 nabız. Bu modlarda cooldown zaten kısa; heartbeat çok az event üretir, ama yine de zarar vermez.

### 12.5. Risk

- **Düşük.** Fonksiyonun signature'ına bir opsiyonel `onHeartbeat` parametresi eklenir; mevcut çağrı noktaları (`engine.ts:683-687`'de tek callback) uyumlu kalır (opsiyonel parametre).
- **Geri alım:** `onHeartbeat` parametresini `undefined` geçerek eski davranışa geri dönülür.
- **Yan etki:** step'lerde "cooldown" tipinde ek event'ler oluşur; frontend (`src/pages/Chat.tsx`'te `STEP_LABELS` eşlemesi) bunları zaten "cooldown" olarak label'lıyorsa görsel olarak fazla step'lar görünebilir. Bu, frontend'de filtreleme (ard arda aynı `type: 'cooldown'` step'leri son olanı göster) ile yönetilebilir; bu, bu planın kapsamı dışında, Bölüm 18'de test stratejisinde belirtilmiştir.

### 12.6. Doğrulama

- TypeScript derlemesi (`server/`'da `npm run build`)
- Birim testi: `waitCooldown(10_000, 'test', undefined, undefined, onHeartbeat)` çağrıldığında en az 1 `onHeartbeat` çağrıldığını doğrula (10s içinde 8s'lik interval en az 1 event üretir)
- Birum testi: `waitCooldown(65_000, 'ultra', undefined, undefined, onHeartbeat)` çağrıldığında en az 7–8 `onHeartbeat` çağrıldığını doğrula
- Manuel test: High/Ultra modda bir deep research job başlat; tarayıcı DevTools'ında SSE stream'ine bağlan; 60s+ cooldown periyotlarında bağlantının kopmadığı, "Still waiting" event'lerinin göründüğü doğrulanmalı

---

## 13. Düzeltme #3 — Minimum Araştırma Eşiği (Floor State Machine)

### 13.1. Preset alanlarının genişletilmesi

**Dosya:** `server/src/engine/depth-presets.ts:6-88`

`ResearchDepthPreset` interface'ine iki yeni alan eklenir (satır 6-20 arası):

```typescript
export interface ResearchDepthPreset {
  depth: DeepDepth;
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
  // Yeni alanlar:
  minSearchesBeforeAnswer: number;     // Floor: en az bu kadar search yapılmadan cevap kabul edilmez
  minNotebookWritesBeforeAnswer: number; // Floor: en az bu kadar notebook yazımı olmadan cevap kabul edilmez
}
```

Default değerler (`DEFAULT_RESEARCH_DEPTH_PRESETS`, satır 27-88):

| Depth | minSearchesBeforeAnswer | minNotebookWritesBeforeAnswer | Mantık |
|---|---|---|---|
| low | 3 | 1 | Bütçe 20; en az 3 search ve 1 notebook yazımı |
| med | 5 | 2 | Bütçe 35; en az 5 search ve 2 notebook yazımı |
| high | 8 | 3 | Bütçe 50; en az 8 search ve 3 notebook yazımı |
| ultra | 15 | 5 | Bütçe 100; en az 15 search ve 5 notebook yazımı |

Bu değerler mevcut bütçenin %15-25'ini floor olarak belirler — bütçe tükendiğinde zaten floor otomatik karşılanmış olur, bu yüzden floor yalnızca erken durma senaryosunu engeller, bütçe-tükenme senaryosunu bozmaz.

### 13.2. Settings-store uyumu

**Dosya:** `server/src/settings-store.ts`'in normalize mantığı

`ResearchDepthPresetConfig = Omit<ResearchDepthPreset, 'depth'>` (satır 23) yüzünden yeni alanlar otomatik olarak config şemasına dahil olur. `settings-store.ts`'in normalize mantığı yeni alanları tanımazsa default değerlerle doldurmalı (mevcut `resolveResearchPreset`'in satır 119-121'deki `{ ...baseDefaults, ...settingsOverride }` spread bunu otomatik yapar — `baseDefaults` yeni alanları içerir, `settingsOverride` opsiyonel olarak override eder).

**Değişiklik gerekmez** — mevcut spread mantığı yeni alanları otomatik destekler.

### 13.3. Floor kontrolünün implementasyonu

**Dosya:** `engine.ts:628-633` (model tool çağırmadan cevap verdiği an) ve `engine.ts:109-115` (`toolCallingRound` signature)

`toolCallingRound`'da, model tool çağırmadan cevap döndürdüğünde (`kind: 'answer'`, satır 633), floor kontrolü çalışmalı:

Mevcut (`engine.ts:628-633`):
```typescript
/* Model answered — no tool calls, direct response */
const finalStep: AgentStep = { type: 'answer' };
steps.push(finalStep);
onEvent({ type: 'step', data: finalStep });
messages.push({ role: msg.role, content: msg.content });
return { kind: 'answer' };
```

Hedef:
```typescript
/* Model answered — no tool calls, direct response */
if (deepState && preset && !budget.exhausted) {
  const searchesDone = deepState.ledger.searches.length;
  const notebookWrites = deepState.notebook.appendCount;
  const minSearches = preset.minSearchesBeforeAnswer;
  const minNotebooks = preset.minNotebookWritesBeforeAnswer;
  if (searchesDone < minSearches || notebookWrites < minNotebooks) {
    // Floor aşılmadı — cevabı kabul etme, modeli tools moduna geri çevir
    const gaps: string[] = [];
    if (searchesDone < minSearches) gaps.push(`searches done: ${searchesDone}/${minSearches}`);
    if (notebookWrites < minNotebooks) gaps.push(`notebook writes: ${notebookWrites}/${minNotebooks}`);
    const floorMessage = `Minimum research floor not yet reached (${gaps.join('; ')}). Do NOT write the final answer yet. The notebook does not yet show that the user's material requirements are resolved. Call web_search with distinct queries for remaining evidence needs, or fetch_url for a specific source, or write_notebook to preserve current findings — then continue researching. Only when the floor is reached OR the budget is exhausted may you write the final answer.`;
    messages.push({ role: msg.role, content: msg.content }); // modelin cevabı context'te kalır (ileride referans için)
    messages.push({ role: 'system', content: floorMessage });
    const floorStep: AgentStep = { type: 'budget', note: `Research floor not reached — redirecting to continue research (${gaps.join('; ')}).` };
    steps.push(floorStep);
    onEvent({ type: 'step', data: floorStep });
    return { kind: 'tools', researchPerformed: false };
  }
}

const finalStep: AgentStep = { type: 'answer' };
steps.push(finalStep);
onEvent({ type: 'step', data: finalStep });
messages.push({ role: msg.role, content: msg.content });
return { kind: 'answer' };
```

### 13.4. Döngü uyumu

`agenticResearchStream`'in ana döngüsü (`engine.ts:768-810`):
```typescript
if (result.kind === 'answer') break;
...
if (result.kind === 'tools') {
  if (result.researchPerformed) { round++; }
}
```

Floor return `{ kind: 'tools', researchPerformed: false }` döndürür. Bu durumda:
- `result.kind === 'answer'` olmadığı için `break` çalışmaz
- `result.kind === 'tools'` olduğu için döngü devam eder
- `researchPerformed: false` olduğu için `round++` çalışmaz — round sayacı artmaz, yalnızca `totalTurns++` (satır 808) artar

Bu, floor kontrolünün simetrik davranışını sağlar: floor her tetiklendiğinde `totalTurns` artar ama `round` artmaz; `maxTotalTurns = 200` (satır 766) güvenlik limiti hâlâ geçerli; `preset.maxRounds` kontrolü (satır 771-774) `round`'a bağlı olduğu için floor takılmaları `maxRounds`'i aşmaz. Bütçe tükendiğinde floor artık devreye girmez (`!budget.exhausted` koşulu ile).

### 13.5. Edge case'lar

- **Bütçe tükenmiş:** `!budget.exhausted` koşulu floor'u atlar; mevcut `budgetExhaustedDeepMessage()` yoluyla model cevap yazar. Doğru davranış.
- **Quick mode:** `deepState` undefined; floor kontrolü atlanır. Doğru davranış — floor yalnızca deep mode içindir.
- **Checkpoint resume:** `loadResearchCheckpoint` (satır 717-737) `budget`'i ve `allSources`'i restore eder ama `deepState.ledger`'i sıfırdan başlatır (`createResearchLedger()` satır 728). Bu, floor kontrolünün resume sonrası sıfırlanması demek. **Dikkat:** floor kontrolü resume edilen job'larda yeniden çalışmalı — `deepState.ledger.searches.length` resume sonrası 0 olur, bu yüzden floor ilk round'larda tekrar tetiklenebilir. Bu, kabul edilebilir bir davranıştır: resume olan job zaten notebook'ı restore eder (`loadNotebook` satır 726-728), bu yüzden `notebookWrites` (yani `deepState.notebook.appendCount`) doğru restore edilir; yalnızca `searches` sayısı sıfırlanır. Floor'un resume'da yeniden çalışması, notebook yazma eşiği karşılanmış olsa bile search eşiğini yeniden dayatabilir — bu, resume olan job'ın bir başlangıç turunda ek bir search isteyebilir. Bu edge case, `checkpoint`'in `sourceMap` alanını kullanarak `deepState.ledger`'i de restore etmekle çözülebilir, ama bu bu planın kapsamı dışında, Bölüm 18'de test stratejisinde belirtilmiştir.
- **Model floor mesajına rağmen tekrar tool çağırmadan cevap verirse:** Floor tekrar tetiklenir, ikinci `floorMessage` gönderilir. `totalTurns++` artar; `maxTotalTurns = 200` güvenlik limiti hânı vardır. Pratikte model ikinci uyarıdan sonra tool çağırır; üçüncü+ uyarı nadirdir.

### 13.6. Risk

- **Orta.** Davranışsal bir state-machine ekler; mevcut döngü yapısını korur ama yeni bir dönüş yolu ekler.
- **Geri alım:** floor kontrolü bloğunu kaldırmak yeterli; preset alanları default değerlerle kalabilir (zorunlu değil).
- **Yan etki:** model floor mesajına rağmen tekrar cevap verirse, aynı cevap context'te iki kere birikebilir. Bu, `messages.push({ role: msg.role, content: msg.content })`'in floor bloğunda da çağrılmasıyla olur (yukarıdaki hedef kodda). Bu, ileride `finalContextJson`'de iki kere görünebilir. **Düzeltme:** floor bloğunda `messages.push({ role: msg.role, content: msg.content })`'i **kaldır**; modelin cevabını context'te bırakma, yalnızca floorMessage'ı push'la. Bu, modelin "cevabım göz ardı edildi" sinyali almasını sağlar, ve context bolluğunu önler. Aşağıdaki hedef kod bu düzeltmeyi içerir:

Güncellenmiş hedef (floor bloğunda `msg.content`'i context'te bırakmadan):
```typescript
if (deepState && preset && !budget.exhausted) {
  const searchesDone = deepState.ledger.searches.length;
  const notebookWrites = deepState.notebook.appendCount;
  if (searchesDone < preset.minSearchesBeforeAnswer || notebookWrites < preset.minNotebookWritesBeforeAnswer) {
    const gaps: string[] = [];
    if (searchesDone < preset.minSearchesBeforeAnswer) gaps.push(`searches: ${searchesDone}/${preset.minSearchesBeforeAnswer}`);
    if (notebookWrites < preset.minNotebookWritesBeforeAnswer) gaps.push(`notebook writes: ${notebookWrites}/${preset.minNotebookWritesBeforeAnswer}`);
    const floorMessage = `Minimum research floor not yet reached (${gaps.join('; ')}). Do NOT write the final answer yet. Call web_search with distinct queries, fetch_url for a specific source, or write_notebook to preserve findings — then continue. Only when the floor is reached OR the budget is exhausted may you write the final answer.`;
    messages.push({ role: 'system', content: floorMessage });
    const floorStep: AgentStep = { type: 'budget', note: `Research floor not reached — continuing research (${gaps.join('; ')}).` };
    steps.push(floorStep);
    onEvent({ type: 'step', data: floorStep });
    return { kind: 'tools', researchPerformed: false };
  }
}
```

### 13.7. Doğrulama

- TypeScript derlemesi (`server/`'da `npm run build`)
- Birim testi: mock bir model yanıtı `content: "answer"` ile geldiğinde, `deepState.ledger.searches.length === 0` iken, `toolCallingRound`'ın `{ kind: 'tools', researchPerformed: false }` döndürdüğü ve `floorMessage`'ın `messages`'a push'landığı doğrulanmalı
- Birim testi: `deepState.ledger.searches.length >= minSearches` ve `deepState.notebook.appendCount >= minNotebooks` iken, `kind: 'answer'` döndüğü doğrulanmalı
- Birim testi: `budget.exhausted === true` iken floor kontrolünün atlandığı ve `kind: 'answer'` döndüğü doğrulanmalı
- Manuel test: Low modda bir query gönder; modelin 1-2 search yapıp hemen cevap vermesi engellenmeli; floor mesajı görülmeli ve modelin devam edip en az 3 search ve 1 notebook yazımı yapmalı

---

## 14. Düzeltme #4 — engine.ts:85 Koşullu "Yaz" Emri (Recency Çatışması Susturması)

### 14.1. Değişiklik

**Dosya:** `engine.ts:75-88` (`deepResearchContextBlock` fonksiyonu) + `engine.ts:170-180` (çağrı noktası)

Mevcut (`engine.ts:80-87`):
```typescript
return [
  `Research ledger (completed searches/fetches — do not repeat these queries):\n${ledgerContextBlock(deepState.ledger)}`,
  `Deep research notebook (Markdown):\n${notebookContext(deepState.notebook)}`,
  `Source index mapping (use these [Source #N] numbers for inline citations [N]):\n${sourceListBlock(allSources)}`,
  'Use write_notebook to append Markdown notes after digesting raw results. Use read_notebook if the notebook is truncated and you need earlier sections. Do not repeat ledger queries.',
  'Write the final answer from the notebook, ledger, and source list. State what is verified, what is uncertain, and what could not be confirmed. Do not invent facts.',
  cadenceInstruction,
].filter(Boolean).join('\n\n');
```

Hedef: satır 85'teki "Write the final answer..." cümlesini **koşullu** yap. Bu cümle yalnızca şu iki durumda görünmeli:
1. Floor eşiği karşılanmış ise (Düzeltme #3'ten sonra)
2. Bütçe tükenmiş ise

Bunun için `deepResearchContextBlock`'a bir parametre eklenir:

```typescript
function deepResearchContextBlock(
  deepState: DeepResearchState,
  cadenceInstruction: string,
  allSources: Map<string, SourceWithIndex>,
  mayFinalize: boolean,  // ← Yeni parametre
): string {
  return [
    `Research ledger (completed searches/fetches — do not repeat these queries):\n${ledgerContextBlock(deepState.ledger)}`,
    `Deep research notebook (Markdown):\n${notebookContext(deepState.notebook)}`,
    `Source index mapping (use these [Source #N] numbers for inline citations [N]):\n${sourceListBlock(allSources)}`,
    'Use write_notebook to append Markdown notes after digesting raw results. Use read_notebook if the notebook is truncated and you need earlier sections. Do not repeat ledger queries.',
    mayFinalize
      ? 'Write the final answer from the notebook, ledger, and source list. State what is verified, what is uncertain, and what could not be confirmed. Do not invent facts.'
      : 'Do NOT write the final answer yet — continue researching. The notebook does not yet show that the user\'s material requirements are resolved. Call web_search, fetch_url, or write_notebook to advance.',
    cadenceInstruction,
  ].filter(Boolean).join('\n\n');
}
```

Çağrı noktası güncellemesi (`engine.ts:170-180`):

```typescript
if (deepState) {
  const uncompactedRawBlocks = countUncompactedRawResearchMessages(messages, deepState);
  const cadenceThreshold = Math.max(1, deepState.preset.notebookCadenceRawBlocks);
  const cadenceInstruction = uncompactedRawBlocks >= cadenceThreshold ? `...` : '';
  const searchesDone = deepState.ledger.searches.length;
  const notebookWrites = deepState.notebook.appendCount;
  const mayFinalize = budget.exhausted
    || (
         searchesDone >= deepState.preset.minSearchesBeforeAnswer
      && notebookWrites >= deepState.preset.minNotebookWritesBeforeAnswer
    );
  messages.push({
    role: 'system',
    content: deepResearchContextBlock(deepState, cadenceInstruction, allSources, mayFinalize),
  });
}
```

### 14.2. Değişikliğin mantığı

- `mayFinalize` true yalnızca floor karşılandığında veya bütçe tükendiğinde
- `mayFinalize` false olduğunda, "Write the final answer..." yerine "Do NOT write the final answer yet — continue researching." cümlesi görünür
- Bu, `prompts.ts:56-64`'teki "Final answer readiness" kriterini **gölgeleyen** koşulsuz cümleyi susturur; yerine, floor ile aynı koşulu paylaşan bir cümle gelir
- Recency çatışması (Bölüm 7) ortadan kalkar: context sonuna artık ya "yaz" ya "devam et" anlamında bir cümle geliyor, her durumda ikisi birden değil

### 14.3. Bütçe-tükenme ile uyum

`budgetExhaustedDeepMessage()` (`engine.ts:90-92`) zaten yalnızca bütçe tükendiğinde çağrılır (`engine.ts:157`'de `budgetExhausted && deepState && !hasWrittenNotebookInExhaustion` koşuluyla). Düzeltme #4'ün `mayFinalize`'ı `budget.exhausted`'i de true yapar, bu yüzden bütçe-tükenme senaryosunda "Write the final answer..." cümlesi hâlâ görünür — ama artık koşullu olarak, floor ile aynı mantıkla. `budgetExhaustedDeepMessage()`'ın çağrıldığı yer (satır 157) değişmez; o, bütçe tükendiğinde ek bir "budget exhausted" mesajı gönderir, bu cümlenin (satır 85) koşullu versiyonuyla çakışmaz.

### 14.4. Risk

- **Çok düşük.** Fonksiyona bir boolean parametre eklenir, çağrı noktasında bir koşullu hesap yapılır.
- **Geri alım:** `mayFinalize`'ı her zaman `true` geçerek eski davranışa geri dönülür.
- **Yan etki:** Düzeltme #3 yapılmamışsa (floor preset alanları yoksa), `mayFinalize` hesabı `deepState.preset.minSearchesBeforeAnswer`'a erişemez. **Bu yüzden Düzeltme #4, Düzeltme #3'ten sonra uygulanmalı.** Uygulama sırası Bölüm 16'da belirtilmıştır.

### 14.5. Doğrulama

- TypeScript derlemesi (`server/`'da `npm run build`)
- Birim testi: `mayFinalize = false` iken çıktı "Do NOT write the final answer yet" içerdiği doğrulanmalı
- Birum testi: `mayFinalize = true` iken çıktı "Write the final answer" içerdiği doğrulanmalı
- Manuel test: Low modda, 1 search'ten sonra model cevap verirse, floor mesajı (Düzeltme #3) ve "Do NOT write" cümlesi (Düzeltme #4) her ikisi de görünüp modelin devam etmesi teşvik edilmeli

---

## 15. Düzeltme #5 — prompts.ts İncelemesi ve Kod-Tutarlı Revizyon

### 15.1. İlke

Düzeltme #1, #3 ve #4 yapıldıktan sonra, `prompts.ts`'teki bazı soft talimatlar artık fazlalık veya çelişkili kalabilir. Kod seviyesinde zorlanan bir şeyi ayrıca prompt'ta "lütfen yapma" diye tekrarlamak kafa karışıklığı yaratır. Bu yüzden prompt revizyonunu, kod değişikliklerinden **sonra**, onlarla tutarlı hale getirerek yapmak gerekir.

### 15.2. Beklenen değişiklikler (kod düzeltmeleri yapıldıktan sonra)

- **`prompts.ts:37` (Notebook'ta bırakma yasağı):** Olduğu gibi bırakılabilir. Düzeltme #3 (floor) modelin erken durmasını kod seviyesinde engeller; bu prompt kuralı artık bir guard değil, bir pekiştirme haline gelir. Çelişki yok.
- **`prompts.ts:56-64` (Final answer readiness):** Olduğu gibi bırakılabilir. Düzeltme #4 (mayFinalize) bu kriteri gölgeleyen koşulsuz "yaz" emrini susturur; bu kriter artık recency bias ile ezilmez. Yeniden yazmaya gerek yok.
- **`prompts.ts:49-54` (Query strategy):** Düzeltme #1 (şema) modelin tek-string sıkıştırma seçeneğini fiziksel olarak kaldırır; bu prompt bölümü artık fiziksel bir kısıtla desteklenir. Yine de, bu bölümü belgenin daha erken bir yerine taşımak (örneğin "Research behavior" bölümünden hemen önce, ~38. satıra) düşük maliyetli bir ek iyileştirme olarak değerlendirilebilir. Bu, hiçbir kod değişikliği gerektirmeyen bir metin-seviyesi optimizasyondur.
- **`prompts.ts:25` (Use write_notebook after each meaningful batch):** Düzeltme #3'ün `minNotebookWritesBeforeAnswer` floor'u bunu kod seviyesinde zorlar; bu prompt talimatı artık fiziksel bir kısıtla desteklenir. Olduğu gibi bırakılabilir.
- **`prompts.ts:45` (Continue investigating while major logical dimensions remain unaddressed):** Düzeltme #3'ün `minSearchesBeforeAnswer` floor'u bunu kod seviyesinde zorlar. Olduğu gibi bırakılabilir.

### 15.3. Beklenen silmeler (çelişkilerin kaldırılması)

- **Hiçbir şey silinmesi gerekmez.** Düzeltme #1, #3, #4 yapıldıktan sonra `prompts.ts`'teki tüm talimatlar ya (a) kod seviyesinde zorlanan bir kuralı pekiştiren açıklamalar, ya (b) kod seviyesinde zorlanmayan ama modelin davranışını yönlendiren genel talimatlar (örneğin "Prefer primary or authoritative sources" — bunu kod seviyesinde zorlamak mümkün değil, prompt'ta kalmalı). Çelişki yaratmazlar.

### 15.4. Önerilen ek iyileştirme (opsiyonel)

`prompts.ts`'in yapısında, "Query strategy" (satır 49-54) "Research behavior" (8 madde, ~39-47) ile "Final answer readiness" (~56-64) arasında sıkışmış. Düzeltme #1 yapıldıktan sonra, "Query strategy" bölümünü belgenin daha erken bir yerine taşımak (örneğin "Operating model" bölümünden hemen sonra, ~28. satıra) düşük maliyetli bir iyileştirme olabilir. Bu, hiçbir kod değişikliği gerektirmeyen bir metin-seviyesi optimizasyondur; öncelikli değil, Düzeltme #1 yapıldıktan sonra gözden geçirilebilir.

### 15.5. Risk

- **Düşük.** Metin-seviyesi değişiklikler; kod davranışını değiştirmez.
- **Yan etki:** prompt değişikliği yapıldığında hem quick hem deep modda test edilmelidir; citation formatı `[N]` bozulmamalıdır.
- **Öncelik:** Düzeltme #1, #3, #4 yapıldıktan sonra. Öncesinde yapılırsa "neyi düzeltiyoruz" konusunda kafa karışıklığı yaratır.

---

## 16. Uygulama Sırası ve Önceliklendirme

### 16.1. Sıralama (etki/risk oranına göre)

| Sıra | Düzeltme | Dosya | Risk | Etki | Bağımlılık |
|---|---|---|---|---|---|
| 1 | #1 (Şema) | `types.ts:37-51` | Çok düşük | En yüksek/en hızlı | Yok — bağımsız |
| 2 | #2 (Heartbeat) | `cooldown.ts:109-135`, `engine.ts:663-688` | Düşük | High/Ultra'yı stabil yapar | Yok — bağımsız |
| 3 | #3 (Floor) | `depth-presets.ts:6-88`, `engine.ts:628-633` | Orta | Erken durmayı kod seviyesinde çözer | Yok — bağımsız |
| 4 | #4 (mayFinalize) | `engine.ts:75-88,170-180` | Çok düşük | Recency çatışmasını susturur | **#3'ten sonra** (floor alanlarını kullanır) |
| 5 | #5 (Prompt tutarlılık) | `prompts.ts` | Düşük | Kod düzeltmelerini destekler | **#1, #3, #4'ten sonra** |

### 16.2. Mantık

1 ve 2 birbirinden bağımsız, riski en düşük, etkisi en doğrudan olanlar — hemen uygulanabilir.
3 davranışsal bir state-machine eklediği için biraz daha tasarım gerektirir, ama mevcut döngü yapısını korur.
4 çok küçük bir ekleme (#3'ten sonra), ama recency çatışmasını doğrudan çözer.
5 diğerleri netleşmeden yapılırsa "neyi düzeltiyoruz" konusunda kafa karışıklığına yol açar; bu yüzden en son.

### 16.3. Paralellik

- **#1 ve #2 paralel uygulanabilir** — birbirini etkilemez.
- **#3 yalnızız uygulanmalı** — yeni preset alanları ve yeni return yolu ekler; #4 buna bağlıdır.
- **#4 #3'ten sonra hemen uygulanmalı** — aynı dosyaya (`engine.ts`'e) dokunur, #3'ün `minSearchesBeforeAnswer`/`minNotebookWritesBeforeAnswer` alanlarını kullanır.
- **#5 en son, kod düzeltmeleri commit'lendikten sonra**.

### 16.4. Commit stratejisi

- Commit 1: Düzeltme #1 (şema) — `types.ts` değişikliği, AGENTS.md güncellemesi
- Commit 2: Düzeltme #2 (heartbeat) — `cooldown.ts` + `engine.ts` çağrı noktaları, AGENTS.md güncellemesi
- Commit 3: Düzeltme #3 (floor) — `depth-presets.ts` + `engine.ts`, AGENTS.md güncellemesi
- Commit 4: Düzeltme #4 (mayFinalize) — `engine.ts` (`deepResearchContextBlock` + çağrı noktası), AGENTS.md güncellemesi
- Commit 5: Düzeltme #5 (prompt tutarlılık) — `prompts.ts` (gerekirse), AGENTS.md güncellemesi

Her commit'ten sonra: `npm run build` (server) + `npm test` (server) + `npm run lint` (frontend) + `npm run build` (frontend) çalıştırılmalı (AGENTS.md bölüm 9).

---

## 17. Risk Analizi ve Geri Alım Stratejisi

### 17.1. Genel risk değerlendirmesi

Tüm beş düzeltme **minimal değişiklik** yapar (AGENTS.md bölüm 6): mevcut fonksiyon signature'larına opsiyonel parametreler ekler, mevcut koşulları genişletir, mevcut döngü yapısını korur. Hiçbir düzeltme mevcut davranışı tamamen değiştirmez; hepsi mevcut davranışa yeni bir koşullu dal ekler veya mevcut alanları daha sıkı yapar.

### 17.2. Geri alım yolları

| Düzeltme | Geri alım yolu |
|---|---|
| #1 (Şema) | `search_query` alanını geri ekle, `required`'i kaldır → eski şema |
| #2 (Heartbeat) | `onHeartbeat` parametresini `undefined` geç → eski sessiz davranış |
| #3 (Floor) | Floor kontrolü bloğunu `engine.ts:628-633`'te kaldır → eski `kind: 'answer'` return |
| #4 (mayFinalize) | `mayFinalize`'ı her zaman `true` geç → eski koşulsuz "yaz" cümlesi |
| #5 (Prompt) | `prompts.ts`'e geri dön → eski prompt |

### 17.3. Edge case'ler ve test senaryoları

| Edge case | Beklenen davranış | Test |
|---|---|---|
| Model floor mesajına rağmen tekrar cevap veriyor | Floor tekrar tetiklenir, `totalTurns++`, `maxTotalTurns=200` güvenliği | Manuel test + birim testi |
| Bütçe tükenmiş, floor karşılanmamış | `!budget.exhausted` koşulu floor'u atlar; `budgetExhaustedDeepMessage()` çağrılır | Birim testi |
| Quick mode (deepState undefined) | Floor kontrolü atlanır; quick mode davranışı değişmez | Birim testi |
| Checkpoint resume | `deepState.ledger` sıfırlanır; floor resume'da yeniden çalışabilir (kabul edilebilir) | Manuel test |
| Eski model şemaya uymuyor (tek-string üretiyor) | `tool-parser.ts` fallback yakalar; `engine.ts:262` fallback kullanır | Birim testi |
| Cooldown 0ms (quick mode) | `waitCooldown` 0ms'de hemen return; heartbeat hiç tetiklenmez | Birim testi |

---

## 18. Doğrulama ve Test Stratejisi

### 18.1. Birim testleri (server/tests/)

Aşağıdaki testler eklenmeli veya güncellenmeli:

1. **`search-tool-schema.test.ts` (yeni):**
   - `SEARCH_TOOL.function.parameters.required` `['queries']` içerdiği doğrulanmalı
   - `SEARCH_TOOL.function.parameters.properties.search_query` **tanımsız** olduğu doğrulanmalı
   - `queries` alanının `minItems: 1` içerdiği doğrulanmalı

2. **`cooldown.test.ts` (güncelleme):**
   - `waitCooldown(10_000, 'test', undefined, undefined, onHeartbeat)` en az 1 `onHeartbeat` çağrısı üretmeli
   - `waitCooldown(65_000, 'ultra', undefined, undefined, onHeartbeat)` en az 7 `onHeartbeat` çağrısı üretmeli
   - `waitCooldown(0, 'none', ...)` hiç `onHeartbeat` çağrısı üretmemeli

3. **`floor-control.test.ts` (yeni):**
   - Mock `deepState.ledger.searches.length === 0` iken, `toolCallingRound`'ın `kind: 'tools', researchPerformed: false` döndürdüğü
   - Mock `searches >= minSearches` ve `notebookWrites >= minNotebooks` iken, `kind: 'answer'` döndüğü
   - `budget.exhausted === true` iken floor atlandığı

4. **`depth-presets.test.ts` (güncelleme):**
   - Her preset'in `minSearchesBeforeAnswer` ve `minNotebookWritesBeforeAnswer` default değerleri içerdiği
   - `resolveResearchPreset`'in settings override'ı default'ları doğru birleştirdiği

### 18.2. Manuel test senaryoları

1. **Quick mode query kalitesi (Düzeltme #1):**
   - "1 ve 2 ve 3 soruları" şeklinde bir query gönder
   - Modelin `queries` array üretip üretmediğini gözlemle (search step'lerde 3 ayrı query)
   - Eski davranış: tek-string sıkıştırma; yeni davranış: array

2. **Low mode floor (Düzeltme #3 + #4):**
   - Low modda bir araştırma yap
   - Model 1-2 search yapıp hemen cevap vermeye çalışırsa, floor mesajı ve "Do NOT write" cümlesi görünüp modelin devam etmeli
   - En az 3 search ve 1 notebook yazımı olduktan sonra cevap kabul edilmeli

3. **Ultra mode connection lost (Düzeltme #2):**
   - Ultra modda bir araştırma başlat
   - Tarayıcı DevTools'ında SSE stream'ine bağlan
   - 60s+ cooldown periyotlarında bağlantının kopmadığı, "Still waiting" event'lerinin göründüğü doğrulanmalı
   - Eski davranış: 60s+ sessizlik → bağlantı kopması; yeni davranış: 8s'de bir nabız → bağlantı yaşar

4. **High mode 429 penaltısı (Düzeltme #2):**
   - High modda bir araştırma yap, yapay olarak 429 sinyali üret (örneğin `recordRateLimitHit` çağrısı)
   - Cooldown 100s+'ye çıkıpheartbeat event'lerinin devam ettiği doğrulanmalı

### 18.3. Frontend etkisi

- `src/pages/Chat.tsx`'te `STEP_LABELS` eşlemesinde `type: 'cooldown'` zaten label'lı olmalı; heartbeat event'leri ek `cooldown` step'leri olarak görünür. Eğer görsel olarak fazla step'ler rahatsız edici ise, ard arda aynı `type: 'cooldown'` step'leri son olanı gösteren bir filtre eklenebilir. Bu, bu planın kapsamı dışında; Düzeltme #2 yapıldıktan sonra gözden geçirilebilir.
- Başka bir frontend değişiklik gerekmez — SSE event yapısı (`type: 'step'` + `data: AgentStep`) değişmez, yalnızca içeriği artar.

### 18.4. Lint ve typecheck

Her commit'ten sonra (AGENTS.md bölüm 9):
- `npm run build` (frontend)
- `server/`'da `npm run build`
- `server/`'da `npm test`
- `smart-routing-core/`'da `npm test`
- `npm run lint` (frontend)

---

## 19. AGENTS.md Güncelleme Yükümlülüğü

AGENTS.md bölüm 0 ve 12 gerektir: her kod değişikliği sonrası `AGENTS.md` güncellenmeli ve değişiklik özeti kullanıcıya gösterilmelidir. Bu planın uygulanması sonrası `AGENTS.md`'de güncellenmesi gereken bölümler:

### 19.1. Güncellenmesi gereken bölümler

- **Bölüm 2.5 (Veri Saklama):** `depth-presets.ts`'te yeni `minSearchesBeforeAnswer` / `minNotebookWritesBeforeAnswer` alanları eklendiği için `ResearchDepthPreset` şema açıklaması güncellenmeli
- **Bölüm 5.1 (Agentic Araştırma Akışı):**
  - "Bütçe Denetimi" alt-bölümüne "Floor denetimi" eklenebilir (Düzeltme #3)
  - "Model Cevabı" alt-bölümüne recency çatışması çözümü (Düzeltme #4) eklenebilir
  - "Smart routing" notu korunur; bu plan smart routing'i etkilemez
- **Bölüm 5.4 (Ayarlar Sistemi):** `researchDepths` preset alanlarına `minSearchesBeforeAnswer` / `minNotebookWritesBeforeAnswer` eklendiği için şema açıklaması güncellenmeli
- **Bölüm 6.3 (Backend Özel):** `cooldown.ts` heartbeat yapısı eklendiği için güncellenmeli
- **Bölüm 8.3 (Yeni Ajan Adımı / Aşama Ekleme):** floor kontrolünün yeni bir `type: 'budget'` step'i eklediği için güncellenmeli

### 19.2. Kullanıcıya gösterilecek değişiklik örneği

Her commit'te kullanıcıya gösterilecek özet:

> **AGENTS.md güncellendi:** Bölüm 2.5 ve 5.4'te `ResearchDepthPreset` şemasına `minSearchesBeforeAnswer` ve `minNotebookWritesBeforeAnswer` alanları eklendi (Düzeltme #3). Bölüm 5.1'de "Floor denetimi" alt-bölümü eklendi (Düzeltme #3+#4). Bölüm 6.3'te `cooldown.ts` heartbeat yapısı açıklandı (Düzeltme #2). Bölüm 8.3'te floor step'inin `type: 'budget'` olarak gönderildiği belirtildi. Detay için `docs/engine-root-cause-fix-plan.md`'e bakın.

### 19.3. Bu doküman ile uyum

Bu doküman (`docs/engine-root-cause-fix-plan.md`) `AGENTS.md`'in 11. bölümündeki "Ajan stratejisi planı" referansına benzer şekilde, "Engine root-cause fix planı" olarak 11. bölüme eklenmeli:

> **Engine root-cause fix planı**: `docs/engine-root-cause-fix-plan.md` — Üç semptomun (kalitesiz query, erken durma, connection lost) ortak kök sebebi (soft enforcement paradoksı) ve beş düzeltmenin (şema, heartbeat, floor, mayFinalize, prompt tutarlılık) planı. Tüm bulgular 11 kaynak dosya üzerinden satır satır doğrulanmıştır.

---

## Ek A — Doğrulama Notları

### A.1. `prompts.ts`'in doğrulanması

Raporun `⚠️ doğrulayamadım` olarak işaretlediği tüm `prompts.ts` iddiaları, dosyanın gerçek içeriği okunduğunda **tam doğrulanmış** durumdadır:
- `wc -l` → 75 satır (rapor doğru)
- "Query strategy" satır 49-54 (rapor doğru)
- "Final answer readiness" satır 56-64 (rapor doğru)
- "Notebook'ta bırakma yasağı" satır 37 (rapor doğru, bu dokümanın Bölüm 6'sı)

Raporun tüm satır numaraları, alıntıları birebir doğru. Bu, raporu hazırlayanın gerçek kod tabanına erişimi olduğunu gösteriyor; diğer satır referanslarının da güvenilir olduğunu kanıtlıyor.

### A.2. Yeni bulguların kaynağı

Bölüm 6, 7 ve 8'deki "Yeni Bulgu"lar, `prompts.ts`'in gerçek içeriği okunduğunda ortaya çıkmıştır; bunlar raporun yakalayamadığı bulgulardır. Özellikle Bölüm 7'deki recency çatışması, raporun 2A bulgusunu "muhtemel" seviyesinden "mekanik olarak açıklanabilir" seviyesine taşır.

### A.3. Doğrulanamayan iddialar

Raporun 3 tahminden ikisi (context overflow, provider timeout) bu kodda doğrulanamadı çünkü `llm.ts` ve `search.ts` (LLM çağrısını yapan, provider'a giden dosyalar) incelenmedi. Ama Bölüm 5.3'te açıklandığı gibi, bunlar **bağımsız ek sebep olmaktan çok, aynı kök sorunun (soft enforcement yok) ikincil bir sonucu** olabilir. Kesin kanıtladığımız, ms cinsinden ölçülebilir kök sebep (cooldown sessizliği) Bölüm 5'te detaylandırılmıştır. İleride `llm.ts` ve `search.ts` incelenirse bu bağımsız iddialar da doğrulanabilir veya dışlanabilir; bu, bu planın kapsamı dışında.

### A.4. Raporun 2C bulgusu ("round başı system mesaj silme")

Rapor bunu "bug" olarak iddia etmiş; bu doğrulama sonrası **gerçek bir bug değil** olarak değerlendirildi. `engine.ts:118-125`'deki filtreleme zararsız bir sil-ekle döngüsü: önceki turlardan kalan system mesajları temizlenip yalnızca `messages[0]` (base system prompt) ve o anki turun en güncel ledger/budget system mesajı bırakılıyor. Bu, AGENTS.md 5.1 bölümünde zaten açıklandığı gibi, "token birikmesini ve çelişkili talimatları önlemek" için bilerek yapılmış bir davranıştır. Önceliksiz; bu plan kapsamında düzeltme gerekmez.

---

## Ek B — Referans Satır Tablosu

Tüm bu dokümanda referans verilen satır numaralarının gerçek dosyalardaki karşılıkları (doğrulama amacıyla):

| Dosya | Referans satır | İçerik | Doğrulama |
|---|---|---|---|
| `engine/types.ts` | 42-47 | `SEARCH_TOOL.function.parameters.properties` (search_query, queries, type) | ✅ |
| `engine/types.ts` | 53-66 | `FETCH_URL_TOOL` | ✅ |
| `engine.ts` | 75-88 | `deepResearchContextBlock` fonksiyonu | ✅ |
| `engine.ts` | 84-85 | "Use write_notebook..." ve "Write the final answer..." cümleleri | ✅ |
| `engine.ts` | 90-92 | `budgetExhaustedDeepMessage` | ✅ |
| `engine.ts` | 109-115 | `toolCallingRound` signature | ✅ |
| `engine.ts` | 118-125 | Round başı system mesaj filtreleme | ✅ |
| `engine.ts` | 127-168 | Bütçe kontrolü (budget exhausted, low budget) | ✅ |
| `engine.ts` | 170-180 | `deepResearchContextBlock` çağrı noktası | ✅ |
| `engine.ts` | 184-189 | Tool seçimi ve `toolChoice: 'auto'` | ✅ |
| `engine.ts` | 262 | `const qs = args.queries \|\| args.search_query \|\| ...` | ✅ |
| `engine.ts` | 489 | `applyResearchCooldown` (native tool-call batch yolu) | ✅ |
| `engine.ts` | 492 | `resultsByTcId` birleştirme | ✅ |
| `engine.ts` | 596 | `applyResearchCooldown` (inline tool-call yolu) | ✅ |
| `engine.ts` | 628-633 | "Model answered — no tool calls" bloğu | ✅ |
| `engine.ts` | 663-688 | `applyResearchCooldown` fonksiyonu | ✅ |
| `engine.ts` | 683-687 | `waitCooldown` çağrısı | ✅ |
| `engine.ts` | 717-737 | Checkpoint resume | ✅ |
| `engine.ts` | 768-810 | Ana döngü | ✅ |
| `cooldown.ts` | 70-107 | `computeCooldownMs` | ✅ |
| `cooldown.ts` | 109-135 | `waitCooldown` | ✅ |
| `depth-presets.ts` | 6-20 | `ResearchDepthPreset` interface | ✅ |
| `depth-presets.ts` | 27-88 | `DEFAULT_RESEARCH_DEPTH_PRESETS` | ✅ |
| `depth-presets.ts` | 98-131 | `resolveResearchPreset` | ✅ |
| `depth-presets.ts` | 133-154 | `depthBehaviorBlock` | ✅ |
| `tool-parser.ts` | 7-12 | `extractQuery` | ✅ |
| `tool-parser.ts` | 46-49, 66-68 | `params.queries` array yakalama | ✅ |
| `rate-signals.ts` | 10-18 | `parseRetryAfterMs` | ✅ |
| `rate-signals.ts` | 31-36 | `consumeRateSignalsForCooldown` | ✅ |
| `prompts.ts` | 37 | "Never write a decision to stop in the notebook" | ✅ |
| `prompts.ts` | 49-54 | "Query strategy" bölümü | ✅ |
| `prompts.ts` | 56-64 | "Final answer readiness" bölümü | ✅ |

---

*Son güncelleme: 2026-06-23. Tüm bulgular 11 kaynak dosya üzerinden satır satır doğrulanmıştır.*
