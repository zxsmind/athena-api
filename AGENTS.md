# ATHENA-001 — Agent Guide

> Bu doküman, ATHENA-001 projesinde çalışan AI ajanları (coding agent'ları) için kapsamlı bir bağlam ve çalışma rehberidir. İnsan kullanıcıya yönelik hızlı başlangıç değildir; `README.md` onun içindir. Buradaki bilgiler, kod değişikliği yapmadan önce bilinmesi gereken mimari, teknoloji yığını, konvansiyonlar ve dikkat edilmesi gereken kritik kuralları içerir.

---

## 0. AGENTS.md Güncelleme ve Doğruluk Kuralı

> **Bu dosyanın güncelliği ve doğruluğu, projenin sürdürülebilirliği için kritiktir.**
> **Bu dosya, tüm AI ajanlarının (agent'ların) çalışma prensiplerini belirler; her ajan değişiklik yaptıktan sonra bu dosyayı güncellemek ve değişiklik özetini kullanıcıya göstermek ZORUNLUDUR.**

- Her kod değişikliği, mimari değişikliği veya yeni özellik eklenmesi sonrasında, bu `AGENTS.md` dosyasındaki ilgili bölümler gözden geçirilmeli ve gerekirse güncellenmelidir.
- Eğer bir değişiklik, bu dokümanda yazan bir kuralı, mimariyi, endpoint'i, ayar şemasını veya konvansiyonu değiştiriyorsa, **önce veya hemen sonra** doküman da düzeltilmelidir.
- Eksik, yanlış veya eski kalan bilgi bulunursa, proje taranmalı ve doğru haliyle değiştirilmelidir. Sadece kodu değiştirip dokümanı unutmak yasaktır.
- Yeni bir konvansiyon, güvenlik kuralı veya kritik davranış ortaya çıkarsa, bu dosyaya açıkça eklenmelidir.
- Bu dosya, sonraki ajanlar (ve insan katkıcılar) için tek kaynak doğru (single source of truth) kabul edilir; dolayısıyla her tutarsızlık derhal giderilmelidir.
- **Her ajan, yaptığı her değişiklikten sonra bu dosyayı güncellemeli VE güncellenmiş değişiklik özetini kullanıcıya göstermelidir (örneğin: "AGENTS.md güncellendi: yeni bölüm X, değişen kısım Y").** Kullanıcı görmeden commit atmak yasaktır.
- _Eğer bir ajan bu kuralı ihlal ederse, sonraki ajanlar ihmal edilen güncellemeleri fark etmeli ve düzeltmelidir._

Bu kural, bu dokümanın 12. bölümünde (Son Not) tekrar vurgulanmıştır.

---

## 1. Proje Nedir ve Ne Amaçla Kuruldu?

**ATHENA-001**, "evidence-first" (kanıta dayalı) bir yapay zeka araştırma asistanıdır. Temel amacı:

- Kullanıcının sorduğu herhangi bir konuda **gerçek zamanlı web araması** yapmak,
- Bulduğu kaynakları **inline `[N]` atıf formatıyla** yanıt içinde göstermek,
- Asla hafızadan cevap vermemek; her iddia için bir kaynak sunmak,
- Basit sohbet (chat) deneyiminin ötesinde **uzun süren derin araştırma işleri (jobs)**, **toplu (batch) araştırma** ve **görev bazlı model yönlendirme (model routing)** gibi gelişmiş yetenekler sunmaktır.

Proje, kişisel veya küçük ekip kullanımı için tasarlanmış, yerel ağda çalışan bir uygulamadır. Kimlik doğrulama (authentication) yoktur; API anahtarları yalnızca sunucu tarafında saklanır ve asla istemciye gönderilmez.

---

## 2. Teknoloji Yığını (Tech Stack)

### 2.1. Frontend

| Teknoloji | Kullanım |
|-----------|----------|
| **React 19** + **TypeScript 5.9** | UI mantığı ve tip güvenliği |
| **Vite 8** | Derleme, geliştirme sunucusu, proxy |
| **React Router v7** | Sayfa yönlendirmesi (`/`, `/c/:id`) |
| **MUI (Material UI) v7** + **Emotion** | Bileşen kütüphanesi ve tema |
| **Lucide React** | İkonlar |
| **KaTeX** | Matematik formülleri (inline `$...$` ve blok `$$...$$`) |
| **Mermaid** | Akış şemaları ve diyagramlar |

### 2.2. Backend (Aktif / Birincil)

| Teknoloji | Kullanım |
|-----------|----------|
| **Node.js** + **Express 5** | HTTP API ve SSE (Server-Sent Events) sunucusu |
| **TypeScript 5.9** | Tip güvenliği |
| **tsx** | Geliştirme sırasında TypeScript dosyalarını çalıştırma |
| **Vitest** | Birim testleri (`server/tests/`) |
| **native `fetch`** | Dış API çağrıları (LLM ve web sayfası içeriği) |
| **Serper.dev** | Google arama sonuçları |

### 2.3. Backend (Eski / Legacy — Silindi)

Eski Python FastAPI backend (`backend/` dizini) tamamen kaldırılmıştır, çünkü proje tamamen Node.js/Express (`server/`) üzerine taşınmıştır. Ayarlar `server/data/settings.json` dosyası ile Node.js backend tarafından doğrudan yönetilir. Python kodu bulunmamaktadır.

### 2.4. Akıllı Yönlendirme (Smart Routing)

| Teknoloji | Kullanım |
|-----------|----------|
| **@mindbox/smart-routing-core** | Yerel monorepo paketi (`smart-routing-core/`) |
| **Kendi içinde TypeScript** | Rate limit takibi, fallback zinciri, key/model rotasyonu, "sticky-incumbent" politikası |

Bu paket, LLM çağrılarında birden fazla provider/key/model kombinasyonu arasında akıllıca geçiş yapar. 429, 401, 413, timeout gibi durumları öğrenir ve sonraki çağrılarda daha sağlıklı rotalar seçer.

> **Not:** `docs/settings-modal-redesign-plan.md` artık büyük ölçüde implemente edilmiştir; mevcut `SettingsModal.tsx` 5 sekme (General, Providers, Models, Advanced, API) içerir.

### 2.5. Veri Saklama

- **Sohbetler / Mesajlar**: `server/data/db.json` JSON dosyası (`db.ts`). Her sohbet kaydı (`ConversationMeta`) `mode` (`quick`|`deep`) ve isteğe bağlı `depth` (`low`|`med`|`high`|`ultra`) taşır; F5 ve sidebar navigasyonunda araştırma modu bu metadata'dan restore edilir. Follow-up aramalarda `PUT /conversations/:id/research` ile güncellenir.
- **Araştırma işleri (jobs)**: Bellek içi (in-memory), sunucu yeniden başlayınca silinir.
- **Araştırma toplu işleri (batches)**: Bellek içi.
- **Ayarlar**: `server/data/settings.json` (v2 şema), `settings-store.ts` tarafından yüklenir ve normalize edilir.
- **Deep research notebook'ları**: `server/data/notebooks/{id}.md` altında Markdown olarak tutulur; engine metadata `{id}.meta.json` sidecar dosyasında (model yazmaz). Deep modda model `write_notebook` ile Markdown append eder, `read_notebook` ile (gerekirse) tam/önceki bölümleri okur. Context'e notebook son kısmı en fazla ~10KB olarak enjekte edilir; notebook yazıldıktan sonra raw search/fetch payload'ları kompaktlanır. Eski `{id}.json` notebook'lar ilk yüklemede otomatik `.md`'ye migrate edilir.
- **Research ledger (bellek içi)**: Deep modda `engine/research-ledger.ts` her job için tamamlanan arama/sorgu ve fetch geçmişini tutar; LLM context compaction'dan bağımsızdır. Normalize edilmiş sorgu dedup ile tekrarlayan `web_search` / `fetch_url` çağrıları kredi harcamadan atlanır. Ledger + notebook her tur system context'e enjekte edilir.
- **Gemini provider**: Artık **native REST API** kullanır (`/v1beta/models/{model}:generateContent`), OpenAI-compatible endpoint değil. Auth `x-goog-api-key` header ile yapılır. İstek gövdesi `convertToGeminiBody()` ile OpenAI formatından Gemini native formatına çevrilir. Varsayılan URL: `https://generativelanguage.googleapis.com/v1beta`.

---

## 3. Proje Yapısı (Klasör Düzeni)

```
ATHENA-001/
├── src/                          # React frontend (Vite kök)
│   ├── App.tsx                   # Ana layout, router, sohbet listesi yönetimi
│   ├── main.tsx                  # React root
│   ├── index.css                 # Liquid-glass tasarım sistemi (CSS değişkenleri)
│   ├── theme.ts                  # MUI teması
│   ├── vite-env.d.ts
│   ├── components/               # Yeniden kullanılabilir UI bileşenleri
│   │   ├── SettingsModal.tsx     # Ayarlar modalı (5 sekme: General, Providers, Models, Advanced, API)
│   │   ├── SearchInput.tsx       # Ana arama inputu + autocomplete
│   │   ├── Sidebar.tsx           # Sol yan menü (sohbetler, tema, ayarlar)
│   │   ├── ModeDropdown.tsx      # Instant / Deep Low/Med/High/Ultra mod seçimi
│   │   ├── ActivityModal.tsx     # Aktivite/ayrıntı modalı
│   │   ├── ActivityPanel.tsx
│   │   ├── Background.tsx
│   │   ├── LiquidBackground.tsx
│   │   ├── ContextMenu.tsx
│   │   ├── ContextMenuProvider.tsx
│   │   └── ProgressBar.tsx
│   ├── context/                  # React context'leri
│   │   ├── ColorMode.tsx         # Açık/koyu tema
│   │   └── SettingsModal.tsx     # Settings modal açık/kapalı durumu
│   ├── hooks/                    # Custom hook'lar
│   │   └── useDefaultMode.ts     # Varsayılan quick/deep mod (localStorage)
│   ├── lib/                      # API istemcisi
│   │   └── api.ts                # /api/* endpoint çağrıları, SSE abonelikleri
│   └── pages/
│       ├── Landing.tsx           # Ana sayfa (felsefi alıntılar + büyük arama)
│       └── Chat.tsx              # Sohbet sayfası (lib/Chat değil, pages/Chat)
│
├── server/                       # Node.js / Express backend
│   ├── src/
│   │   ├── index.ts              # Express uygulaması, route tanımları, SSE
│   │   ├── engine.ts             # Agentic araştırma motoru (plan/search/analyze/answer)
│   │   ├── llm.ts                # LLM çağrıları, fallback, smart routing entegrasyonu
│   │   ├── search.ts             # Serper API ve web sayfası içeriği çekme
│   │   ├── settings.ts           # API response için settings dönüştürme katmanı
│   │   ├── settings-store.ts     # settings.json disk okuma/yazma, normalize, cache
│   │   ├── db.ts                 # JSON tabanlı sohbet/mesaj CRUD
│   │   ├── config.ts             # Public config, port, static URL'ler
│   │   ├── schemas.ts            # Paylaşılan TypeScript tipleri
│   │   ├── agent/prompts.ts      # System / synthesis / deep research promptları
│   │   ├── engine/depth-presets.ts # Deep Low/Med/High/Ultra preset resolver ve varsayılanları
│   │   ├── engine/cooldown.ts    # Deep mod dynamic cooldown (depth preset pacing)
│   │   ├── engine/rate-signals.ts # LLM 429 / Retry-After sinyalleri (smart-routing yerine hafif cooldown beslemesi)
│   │   ├── engine/checkpoint.ts  # High/Ultra job checkpoint save/load (disk)
│   │   ├── engine/notebook.ts    # Deep research Markdown notebook (append/read tools, 10KB context cap, legacy JSON migrate)
│   │   ├── engine/research-ledger.ts # Deep mod query/fetch dedup, ledger context block, compaction notları
│   │   ├── research-jobs.ts      # Uzun süren işlerin in-memory yönetimi
│   │   ├── research-batches.ts     # Toplu araştırma işlerinin yönetimi
│   │   └── run-agentic.ts        # CLI test betiği
│   ├── tests/                    # Vitest birim testleri
│   │   ├── research-jobs.test.ts
│   │   ├── research-batches.test.ts
│   │   └── settings-store.test.ts
│   ├── data/db.json              # Sohbet veritabanı (gitignore'da, oluşturulur)
│   ├── package.json
│   ├── tsconfig.json
│   └── vitest.config.ts
│
├── smart-routing-core/           # Yerel npm paketi (LLM fallback & rate-limit routing)
│   ├── src/index.ts              # SmartRoutingEngine implementasyonu
│   ├── src/index.test.ts         # Node:test tabanlı testler
│   ├── dist/                     # Derlenmiş çıktı
│   ├── package.json
│   └── tsconfig.json
│
├── deploy/                       # Deployment sistemi (SSH + hash-incremental + PM2)
│   ├── deploy.sh                 # Bash CLI (Linux/macOS) — delegasyon için wrapper
│   ├── cli.mjs                   # Node.js CLI (cross-platform: Windows, Linux, macOS)
│   ├── deploy.json               # Konfigürasyon dosyası
│   ├── dashboard.html            # Web dashboard (setup formu + yönetim paneli)
│   ├── server.mjs                # HTTP API server (port 4000, engine.mjs'i kullanır)
│   ├── lib/
│   │   ├── utils.mjs             # Config yükleme/kaydetme
│   │   ├── engine.mjs            # DeployEngine (SSH, SCP, manifest, sync, health)
│   │   ├── common.sh             # Logging, SSH helpers, error handling, memory hesaplama
│   │   ├── hash.sh               # SHA256 manifest generation & comparison
│   │   ├── sync.sh               # Incremental tar-pipe sync, release management
│   │   ├── setup.sh              # OS/node/npm detection, dependency install, build
│   │   └── service.sh            # PM2 management, health check, reboot resilience
│   └── templates/                # (opsiyonel şablonlar)
│
├── scripts/                      # Yardımcı betikler
│   ├── clean-dist.mjs            # Prebuild: dist klasörünü temizler
│   ├── deploy-simple.mjs         # Ana deploy script (ssh2 ile git-pull tabanlı deploy, PM2, Tailscale)
│   ├── encrypt-connection.mjs    # Bağlantı bilgilerini AES-256-GCM ile şifreler → scripts/connection.enc
│   ├── sync-settings.mjs         # Local settings.json'u remote'a yükler (tek seferlik)
│   └── .deploy-state/            # (gitignored) connection.json, manifest.json
│
├── public/                       # Frontend static dosyalar
│   ├── favicon.svg
│   ├── icons.svg
│   └── config.json               # (generated) API base URL — deploy script tarafından yazılır
│
├── docs/                         # Proje dokümanları
│   ├── API.md                    # API referansı (v2, Node backend)
│   ├── agent-strategy.md         # Ajan mimarisi v2 planı
│   ├── deep-depth-presets-plan.md # Deep Low/Med/High/Ultra preset tasarım planı
│   └── settings-modal-redesign-plan.md
│
├── Websearchworkersmart.py       # Bağımsız Python CLI betiği (paralel Serper+Groq)
├── vite.config.ts                # Vite yapılandırması + /api proxy
├── package.json                  # Frontend bağımlılıkları
├── tsconfig.json                 # Project references
├── tsconfig.app.json
├── tsconfig.node.json
├── eslint.config.js
└── index.html
```

---

## 4. Çalışma Akışı (Development Workflow)

### 4.1. Geliştirme Ortamını Başlatma

Frontend ve backend ayrı npm projeleridir. Geliştirme için **her ikisi de** çalıştırılmalıdır:

```powershell
# 1. Backend (Node.js) — port 3001
# server/ dizininde:
npm run dev          # tsx watch src/index.ts

# 2. Frontend (Vite) — port 5173
# kök dizinde:
npm run dev          # vite
```

Vite dev sunucusu, `vite.config.ts` içindeki proxy ayarı sayesinde `/api/*` isteklerini otomatik olarak `http://localhost:3001`'e yönlendirir ve `/api` prefix'ini kaldırır. Frontend kodunda API URL'leri `/api/...` şeklinde yazılır.

### 4.2. Üretim Derlemesi

```powershell
# Frontend derleme
npm run build        # dist/ üretir

# Backend derleme
npm run build        # server/ dizininde, dist/ üretir
npm start            # node dist/index.js
```

### 4.3. Test Çalıştırma

```powershell
# Backend birim testleri
npm test             # server/ dizininde vitest run

# Smart routing testleri
npm test             # smart-routing-core/ dizininde

# Frontend testi yoktur (şu an).
```

---

## 5. Mimari ve Önemli Bileşenler

### 5.1. Agentic Araştırma Akışı (`server/src/engine.ts`)

`agenticResearchStream(query, history, onEvent, mode, options)` fonksiyonu, arama motorunun kalbidir. **Tamamen agentic bir döngü** çalışır; ayrı bir "synthesis" fazı yoktur.

1. **Aracı Araştırma Döngüsü**: LLM'e `web_search` ve `fetch_url` araçları verilir. Model, kullanıcı sorusunu alt sorulara böler, arama yapar, sonuçları analiz eder ve yeterli bilgi topladığında doğrudan cevap yazar. Tek bir `toolCallingRound` döngüsü içinde: tool call → sonuç işle → tekrar model çağrısı.
2. **Arama Aşaması**: `search.ts` üzerinden Serper.dev çağrılır; sonuçlar toplanır ve kaynaklar `[N]` index'leri atanır.
3. **Inline Tool Call Parsing**: Bazı modeller (Llama, Qwen) OpenAI `tool_calls` formatı yerine XML/JSON inline çıktı verebilir. `parseInlineToolCall()` bunları yakalar.
4. **Bütçe Denetimi**: Yalnızca **her araç çağrısı** (search/fetch) 1 kredi harcar. `maxCreditsPerQuery` aşılırsa yeni arama yapılmaz, döngü sonlandırılır ve model "cevap yaz" uyarısı alarak cevap üretir. Quick modda bütçe sabit 6 ile sınırlandırılır.
5. **Model Cevabı**: Model `tool_calls` döndürmezse (content ile cevap verirse), bu cevap doğrudan kullanıcıya `{ type: 'token', text }` + `{ type: 'done' }` olaylarıyla iletilir. **Ayrı bir "synthesis" veya "synthesis-fallback" fazı YOKTUR.**

Modlar:
- **quick**: Kullanıcıya "Instant" olarak gösterilir. Dahili model rolü `instant`. Max 3 tur, bütçe 6 kredi.
- **deep**: Dahili model rolü `deep`. `depth` alanı ile `low`, `med`, `high`, `ultra` presetlerinden biri seçilir. Eski deep çağrıları `med` kabul edilir. Varsayılan presetler: low 20 kredi/5 tur, med 35 kredi/8 tur, high 50 kredi/13 tur, ultra 100 kredi/30 tur. Preset snapshot job/batch kaydına yazılır ve çalışan iş ayar değişikliklerinden etkilenmez.

> **Önemli — Tur Hesaplaması:** Derin araştırma modlarında `maxRounds` (tur sınırı) yalnızca **gerçek araştırma işlemleri** (arama ve fetch) yapıldığında artar. `write_notebook` ve `read_notebook` gibi meta-araç çağrıları araştırma turu bütçesini tüketmez. Ayrıca, notebook işlemlerinin kısır döngüye girmesini önlemek için `maxTotalTurns` adında bir güvenlik sınırı bulunur (varsayılan: `Math.max(50, maxRounds * 3)`). Tur sınırı aşıldığında veya bütçe bittiğinde arama/fetch araçları kapatılır ve modelin sadece `write_notebook` yapmasına ve cevabı tamamlamasına izin verilir.

> **Dikkat:** Ayarlarda bulunan `general.deepIterations` ve `research.maxFollowUpQueries` alanları şu anda `engine.ts` içinde aktif olarak kullanılmıyor. Deep mod tur sayısı `engine/depth-presets.ts` presetlerinden gelir; follow-up limiti bütçe, tur sayısı ve per-round search/fetch limitleri tarafından dolaylı olarak sınırlanır. Bu ayarları devreye sokacak bir değişiklik yapmadan önce bu dokümanı ve ilgili kodu güncelleyin.

> **Not:** Deep modda `write_notebook` (Markdown append) ve `read_notebook` tool'ları aktiftir. Notebook `server/data/notebooks/{id}.md` dosyasına yazılır; context'e truncate edilmiş working view enjekte edilir. Raw search/fetch payload'ları notebook yazımından sonra kompaktlanır. Notebook cadence eşiği depth presetine göre belirlenir.

> **Not:** Deep modda `engine/research-ledger.ts` bellek içi bir ledger tutar (checkpoint resume'da sıfırlanır). Tamamlanan arama/fetch kayıtları normalize query/URL ile dedup edilir; duplicate tool call'lar kredi harcamadan reddedilir. Her LLM turunda ledger + notebook + o ana kadar keşfedilen tüm kaynakların başlık/URL ve index eşleşmelerini tutan "Source Index Mapping" listesi system context'e eklenir. Böylece ham araç çıktıları sıkıştırılsa (compaction) dahi model her kaynağı her zaman doğru atıf numarasıyla (`[N]`) eşleştirebilir. Token birikmesini ve çelişkili talimatları önlemek amacıyla, `toolCallingRound` başında önceki turlardan kalan dinamik system mesajları temizlenir; sadece ilk base system prompt (messages[0]) ve o anki turun en güncel ledger/budget system mesajı bağlamda tutulur. Bütçe tükendiğinde model'e yapılandırılmış "cevap yaz" rehberi gönderilir (boşluk doldurma teşviki yok).

> **Not:** Deep modda search/fetch batch sonrası `engine/cooldown.ts` depth preset'e göre dinamik cooldown uygular (low 5-10s, med 10-15s, high 20-40s, ultra min 60s). Hata oranı, 429, `Retry-After` (`engine/rate-signals.ts`) ve latency sinyalleri cooldown'ı artırır; başarı serisi low/med'de hafif azaltır. Cooldown SSE step olarak `type: 'cooldown'` ile gönderilir; notebook yazımına uygulanmaz. Canlı bütçe/notebook durumu `progress` SSE event'i ile iletilir.

> **Not:** High/Ultra presetlerinde `checkpointEveryRounds` > 0 ise engine `server/data/research-checkpoints/{jobId}.json` dosyasına checkpoint yazar; aynı job yeniden başlarsa notebook, budget, round ve kaynak haritasından resume eder. Başarılı tamamlamada checkpoint silinir. Sunucu restart sonrası kalan checkpoint dosyaları otomatik recover edilir. `POST /research-jobs/:id/pause` ve `POST /research-jobs/:id/resume` endpoint'leri High/Ultra job kontrolü içindir.

> **Not:** Cevap modelin kendi `toolCallingRound` yanıtından gelir ve non-streaming `callLLM` ile alınır; tek bir `{ type: 'token', text }` olayı olarak gönderilir. Eski "synthesis" ve "synthesis-fallback" fazları (ve `SYNTHESIS_PROMPT`) kaldırılmıştır.

> **Önemli — finalContext ayrı SSE event'i:** LLM konuşma geçmişi (`finalContext`) büyük olabileceği (50KB+) için `done` SSE event'i için browser EventSource'da silent drop'u önlemek amacıyla **ayrı bir `context` SSE event'i** olarak gönderilir (`engine.ts`). Sıralama: `context` (büyük payload) → `done`/`error` (küçük). `context` event'i düşse bile message completion etkilenmez. Hata ayıklama (debug) kolaylığı için `finalContext` üzerindeki tüm karakter ve mesaj limitleri kaldırılmış olup, tüm konuşma geçmişi kesilmeden iletilmektedir. `makeFinalContextJson(messages)` modül seviyesi helper fonksiyonu tüm call site'larda kullanılır.

### 5.2. LLM Yönlendirme (`server/src/llm.ts`)

- `callLLM` (non-streaming) ve `callLLMStream` (streaming) fonksiyonları.
- Her çağrı bir `role` alabilir: `title`, `reasoning`, `instant`, `deep`.
- `resolveRoleTargetReferences()` ile `modelRouting` ayarlarından primary + fallback zinciri çözülür.
- Eğer hedef rol yoksa veya tüm hedefler başarısız olursa, tüm enabled provider'ların modelleri denenir.
- 429 rate limit, 401 auth, 413 context too large, timeout, stream interruption gibi durumlar için retry ve fallback mantığı vardır.
- Deep modda toplam 5 deneme (1 ilk deneme + 4 global retry) ve exponential backoff (2s, 4s, 8s, 16s) vardır.
- 429 yanıtlarında `Retry-After` header'ı parse edilir ve `engine/rate-signals.ts` modülüne kaydedilir; deep mod cooldown bu sinyali kullanır.

> **Dikkat:** `reasoning` rolü ayarlarda tanımlı olsa da, şu anda `engine.ts` içinde doğrudan kullanılmıyor. Gelecekte ayrı bir analiz/reasoning aşaması eklenecekse bu rol devreye girecektir.

### 5.3. Smart Routing (`smart-routing-core`) — paket mevcut, backend'de henüz bağlı değil

`@mindbox/smart-routing-core` `server/package.json` içinde yerel paket olarak tanımlıdır ve deploy sırasında build edilir; ancak **`server/src/` altında hiçbir dosya bu paketi import etmez**. Aktif LLM yönlendirmesi `llm.ts` + `llm-utils.ts` ile yapılır (rol bazlı primary/fallback, provider/key rotasyonu, deep mod global retry).

Paket yetenekleri (gelecek entegrasyon için):
- `createSmartRoutingEngine()`, `selectRoute()`, `recordOutcome()`
- Runtime learned capacity, 429/retry-after, burst episode, provider pressure

**Şu anki alternatif:** Deep mod dinamik cooldown için `engine/rate-signals.ts` kullanılır — LLM 429 + `Retry-After` sinyallerini toplar ve `engine/cooldown.ts` içindeki `computeCooldownMs()`'e `providerPressure` / `retryAfterMs` olarak iletir. Tam smart-routing entegrasyonu ayrı bir görevdir.

### 5.4. Ayarlar Sistemi (`settings-store.ts` + `settings.ts`)

Ayarlar `server/data/settings.json` dosyasında saklanır. `settings-store.ts`:

- Eski v1 ayarları otomatik v2'ye normalize eder.
- 2 saniyelik cache tutar.
- `loadSettings()` ve `saveSettings()` export eder.

`settings.ts` ise API yanıtı için `keys` dizilerini döner (maskeleme yapılmaz; UI'da maskeleme `SettingsModal.tsx` içindedir).

Ayar şeması v2 ana bölümleri:
- `version`: Şema versiyonu (2).
- `port`: Sunucu portu (`3001` varsayılan). `host` alanı hâlâ şemada tutulur ama **backend her zaman `0.0.0.0` adresine bağlanır** (`config.ts`); `host`/`HOST` ayarı bind adresini değiştirmez. Bunun sebebi: Tailscale veya yerel ağda herhangi bir arayüzden erişilebilir olması istenir; ayarlardaki yanlış bir `host` değeri sebebiyle yalnızca `127.0.0.1`’e kısıtlanma riski ortadan kaldırılır.
- `providers`: `groq`, `gemini`, `vercel`, `openrouter`, `custom` — her biri `enabled`, `keys`, `models`, `url`, `name`.
- `providerOrder`: Deneme sırası.
- `modelRouting`: Her rol için `primary` + `fallback` model referansları.
- `serper`: Arama API anahtarları.
- `research`: `maxCreditsPerQuery`, `maxFollowUpQueries`.
- `researchDepths`: `defaultDepth` + per-depth preset overrides (`low`, `med`, `high`, `ultra`) — budget, rounds, cooldown, notebook cadence, per-round limits, checkpoint interval.
- `api`: `defaultMode`, `defaultMaxConcurrent`, `maxActiveJobs`, `maxActiveBatches`, `maxEventsPerJob`, `maxEventsPerBatch`, `maxRetentionMinutes`.
- `general`: `maxSources`, `deepIterations`, `thinkingStripPatterns`, `titleModel`.

### 5.5. API Endpoint'leri (Özet)

- `POST /search` → bir `research-jobs` oluşturur, `{ id }` döner. Frontend `GET /research-jobs/:id/events` ile SSE bağlanır.
- `GET /research-jobs/:id` → job durumunu ve sonucunu döner.
- `GET /research-jobs/:id/events` → SSE stream (status, step, token, sources, done, error).
- `POST /research-jobs/:id/cancel` → işi iptal eder.
- `GET/POST /research-batches` → toplu araştırma işleri.
- `GET /settings`, `PUT /settings` → ayarları oku/yaz.
- `GET /conversations`, `POST /conversations` (accepts optional `mode`, `depth`), `PUT /conversations/:id/research`, `GET/PUT /conversations/:id/messages`, `PUT /conversations/:id/rename`, `DELETE /conversations/:id`.
- `GET /notebooks/:id` → Araştırma not defterinin (notebook) metaverisini ve Markdown içeriğini döner.
- `GET /autocomplete?q=...` → Google autocomplete proxy.
- `GET /config`, `GET /health`, `GET /ping`, `POST /test-llm`.

> **Dikkat:** `GET /config` şu anda sadece `keyCount` (Groq anahtar sayısı), `serperKeyCount` ve `providerCount` döner (`config.ts`). API dokümantasyonu (`docs/API.md`) daha geniş alanlar gösteriyor olabilir; bu iki kaynak arasında tutarsızlık varsa `config.ts` ve/veya `docs/API.md` güncellenmelidir.

Detaylı dokümantasyon: `docs/API.md`.

---

## 6. Kod Konvansiyonları ve Stil

### 6.1. Genel Kurallar

- **TypeScript strict mod** açık. `noUnusedLocals`, `noUnusedParameters` etkin. Kullanılmayan import/değişken derleme hatası verir.
- **ES Modules** kullanılır. Node.js backend `type: "module"`, `moduleResolution: "bundler"`.
- **Import uzantıları**: Node.js backend `.js` uzantısıyla import eder (`import ... from './llm.js'`). Vite frontend `.ts` uzantısız.
- **Fonksiyon tercihi**: Mümkünse fonksiyon bileşenleri ve hook'lar; sınıf bileşenleri yok denecek kadar az.
- **Inline CSS**: Stil için çoğunlukla `style={{ ... }}` kullanılır; MUI `sx` prop'u değil. CSS değişkenleri `index.css` içinde tanımlıdır.
- **İngilizce değişken/tip/fonksiyon isimleri**: Türkçe kullanıcı mesajları olabilir ama kod İngilizce.
- **Hata mesajları**: Sunucu tarafında kullanıcıya gösterilecek hata mesajları Türkçe veya İngilizce olabilir; mevcut kodda karışık. Yeni hata mesajları tercihen kullanıcının dilinde (Türkçe) olabilir.

### 6.2. Frontend Özel

- `src/lib/api.ts` dışındaki dosyalar doğrudan `fetch` kullanmamalı; API işlemleri merkezi `api.ts`'de olmalı.
- `dangerouslySetInnerHTML` kullanılan yerlerde (markdown render bileşenleri) `escapeHtml` kullanılır; güvenilir.
- Tema değişimi `ColorMode.tsx` ve `document.documentElement.classList` (`dark`/`light`) üzerinden yönetilir.
- `src/theme.ts` MUI teması oluşturur; `useDetectMode()` runtime'da `document.documentElement` ve `prefers-color-scheme` kontrol eder.
- **Runtime backend URL**: `api.ts` açılışta `/config.json`'u okur (metadata). Sırasıyla: `config.json.apiUrl` → `VITE_SERVER_URL` env → `/api` fallback.
  - `public/config.json` deploy script tarafından yazılır, gitignore'dadır.
  - Dev proxy kullanılırken `/api` yeterlidir; remote backend için config.json gerekir.

### 6.3. Backend Özel

- LLM çağrılarında `signal` (AbortSignal) her zaman dikkate alınır; kullanıcı iptal ettiğinde akış durmalı.
- `llm-errors.log` dosyasına 429, 400 ve 413 hataları kaydedilir; 401 hataları kaydedilmez (atlanır). Bu log dosyası gitignore'dadır.
- In-memory job/batch yönetiminde `MAX_JOBS` / `MAX_BATCHES` limitleri aşılırsa en eski kayıtlar silinir.
- `db.json` yazma işlemleri `withLock` ile seri hale getirilmiştir; race condition yoktur.
- **Static files**: Backend, `server/dist/public/` varsa bu dizini `express.static` ile serve eder. Bu, build edilmiş frontend'in backend ile aynı porta düşmesini sağlar. Deploy script `dist/` (Vite build) → `server/dist/public/` kopyalar.

### 6.4. Smart Routing Core Özel

- `const` ile tanımlı fonksiyonlar ve utility fonksiyonlar tercih edilir.
- `satisfies` kullanımı yaygın.
- Node.js yerel `test` runner kullanılır (`node:test`).

### 6.5. Deploy / Update Sistemi (`scripts/deploy-simple.mjs`)

> **Tüm agent'lar (local ve remote) aynı komutla deploy edebilir. Şifre `DEPLOY_SECRET` env var ile AES-256-GCM şifreli dosyadan çözülür, agent şifreyi görmez.**

**Mimari:**
- 1 adet remote sunucu, tüm agent'lar aynı sunucuya deploy eder
- Her agent git push/pull ile değişiklikleri paylaşır
- Deploy = SSH + git pull + rebuild + PM2 restart (dosya sync gerekmez, git yeterli)
- Şifre `scripts/connection.enc` dosyasında AES-256-GCM ile şifrelenir ve git'e commit edilir
- `DEPLOY_SECRET` çevre değişkeni ile runtime'da çözülür; agent şifreyi asla görmez

**Dosyalar:**
| Dosya | Açıklama |
|-------|----------|
| `scripts/deploy-simple.mjs` | Ana deploy script: build, SSH, git pull, rebuild, PM2 restart |
| `scripts/encrypt-connection.mjs` | `connection.json`'u AES-256-GCM ile şifreler → `connection.enc` |
| `scripts/sync-settings.mjs` | Local `settings.json`'u remote'a yükler (tek seferlik) |
| `scripts/.deploy-state/connection.json` | (gitignored) İlk kurulumda oluşan plaintext bağlantı bilgisi |
| `scripts/connection.enc` | (git'te) AES-256-GCM şifreli bağlantı bilgisi |

**İlk Kurulum (insan kullanıcı yapar):**
```powershell
# 1. İlk deploy: bağlantı bilgilerini girer, connection.json oluşur
node scripts/deploy-simple.mjs

# 2. Bağlantıyı şifrele
$env:DEPLOY_SECRET = "benim-gizli-anahtarim"
node scripts/encrypt-connection.mjs
# → scripts/connection.enc oluşur

# 3. Şifreli dosyayı commit et
git add scripts/connection.enc
git commit -m "add encrypted deploy connection"
git push

# 4. Her agent'ın makinesinde DEPLOY_SECRET ortam değişkenini ayarla
#    (profile, .env, veya CI secrets olarak)
```

**Agent Kullanımı (tüm agent'lar için aynı, tek komut):**
```powershell
node scripts/deploy-simple.mjs
```

Script otomatik olarak:
1. `connection.json` (gitignored, dev modu) arar → yoksa `connection.enc`'i dener
2. `connection.enc` varsa `DEPLOY_SECRET` ile çözer → SSH bağlanır
3. Remote'da `git pull` çeker
4. Frontend + smart-routing-core + server rebuild eder
5. PM2 restart athena-server
6. Health check yapar

**Önemli:**
- Agent `connection.enc` dosyasını okur, `DEPLOY_SECRET` env var'ını kullanır, **şifreyi asla görmez**
- Her agent'ın çalıştığı ortamda `DEPLOY_SECRET` ayarlanmış olmalı (kullanıcı ayarlar)
- `connection.json` (plaintext) `.deploy-state/` altındadır, `.gitignore` ile korunur, commit edilmez
- `connection.enc` **commit edilir** — güvenlidir çünkü AES-256-GCM ile şifrelidir

---

## 7. Kritik Güvenlik ve Gizlilik Kuralları

> Bu bölüm **kesinlikle** dikkate alınmalıdır.

1. **API anahtarları asla frontend'e gitmez.** `server/data/settings.json` içindeki `keys` dizileri `GET /settings` yanıtında döner, ancak UI `SettingsModal.tsx` içinde `maskSecret()` ile maskeleme yapar. Yine de anahtarlar istemciye ulaşır; bu bilerek yapılmış bir yerel uygulama tasarımıdır. Üretimde bu ayar endpoint'i daha fazla kısıtlanmalıdır.
2. **`server/data/settings.json` ve `server/data/db.json` commitlenmez.** `.gitignore` içinde belirtilidir. **Asla** bu dosyalara gerçek API anahtarı yazıp commit yapmayın. Eğer yanlışlıkla yapılırsa kullanıcıya hemen bildirin.
3. **`.env` dosyaları gitignore'dadır.** Node.js backend `dotenv` kullanır ama şu anda aktif `.env` dosyası yoktur.
4. **Yeni provider entegrasyonu** yapılırken OpenAI-compatible chat completions formatına uygun olmalıdır. Gemini native formatı `convertToGeminiBody()` ile istek gövdesi çevrilir, yanıt `normalizeGeminiResponse()` ile OpenAI formatına dönüştürülür.
5. **Tool calling desteği olmayan modeller** `NO_TOOL_CALLING_MODELS` set'inde veya runtime'da `learnedNoToolCalling` set'inde tutulur; bu modeller araç çağrısı gerektiğinde atlanır.
6. **Web sayfası çekme (`fetch_url`)**: Dış URL'lere istek atılır; `AbortError` dışındaki hatalar yutulur ve ajan bilgilendirilir. Zararlı içerikten kaçınmak için herhangi bir sanitizasyon yoktur; sonuçlar LLM'e gönderilir.

---

## 8. Sık Karşılaşılacak Değişiklik Senaryoları

### 8.1. Yeni LLM Provider Ekleme

1. `settings-store.ts` içinde `defaults.providers` ve `providerOrder` güncellenir.
2. `server/src/settings.ts` içinde `providerLabels` güncellenir.
3. `frontend/src/components/SettingsModal.tsx` içinde `PROVIDER_KEYS` / `PROVIDER_LABELS` güncellenir.
4. `llm.ts` içinde gerekirse provider özel normalize/dönüştürme eklenir.
5. Testler ve TypeScript derlemesi çalıştırılır.

### 8.2. Yeni Model Rolü Ekleme

1. `settings-store.ts` içinde `ModelRouting` interface ve `createModelRouting()` güncellenir.
2. `settings.ts` içinde `ModelRouting` interface güncellenir.
3. `llm.ts` içinde `LLMRole` tipi otomatik güncellenir.
4. `frontend SettingsModal.tsx` içinde `ROLE_LABELS` güncellenir.
5. `engine.ts` içinde ilgili çağrılara yeni rol atanır.

### 8.3. Yeni Ajan Adımı / Aşama Ekleme

- `server/src/schemas.ts` `AgentStep` zaten esnek bir `type: string` alır.
- `Chat.tsx` içinde `STEP_LABELS` eşlemesine yeni etiket eklenir.
- `engine.ts` içinde `onEvent({ type: 'step', ... })` gönderilir.

### 8.4. Promptları Değiştirme

- Tüm sistem promptları `server/src/agent/prompts.ts` içindedir.
- `SYSTEM_PROMPT`, `DEEP_SYSTEM_PROMPT` (eski `SYNTHESIS_PROMPT` kaldırıldı).
- Prompt değişikliği yapıldığında hem quick hem deep modda test edilmelidir; citation formatı bozulmamalıdır.

### 8.5. Frontend CSS / Tema Değişikliği

- Renk, cam efekt, animasyon gibi tasarım değişiklikleri `src/index.css` içindeki CSS değişkenlerinden yapılır.
- Koyu mod için `.dark` selector'u kullanılır.
- MUI tema değişikliği gerekiyorsa `src/theme.ts` güncellenir.

### 8.6. Deploy / Update (Tüm Agent'lar İçin)

Değişiklik yaptıktan sonra canlı siteye yansıtmak için:

```powershell
# 1. Değişiklikleri commit et ve pushla
git add -A
git commit -m "yaptığın değişiklik"
git push

# 2. Remote sunucuda deploy et
node scripts/deploy-simple.mjs
```

Script otomatik olarak `DEPLOY_SECRET` ile şifreli bağlantıyı çözer, remote'da `git pull` çeker, rebuild eder ve PM2 restart yapar. Agent şifreyi görmez, hiçbir şey sormaz.

> **Uyarı:** Eğer `DEPLOY_SECRET` env var ayarlı değilse script hata verir. Kullanıcıya bildir, devam etme.

---

## 9. Test ve Doğrulama

Her kod değişikliğinden sonra şunlar çalıştırılmalıdır:

```powershell
# 1. TypeScript derleme kontrolü (frontend)
npm run build

# 2. Backend derleme kontrolü
cd server
npm run build

# 3. Backend birim testleri
npm test

# 4. Smart routing testleri (varsa)
cd ../smart-routing-core
npm test

# 5. Lint (frontend)
cd ..
npm run lint
```

Eğer testler mevcut değilse veya değişiklik yeni bir modül etkiliyorsa, mevcut test dosyalarına uygun şekilde yeni testler eklenmelidir.

---

## 10. Ortak Hatalar ve Çözümleri

| Hata | Olası Neden | Çözüm |
|------|-------------|-------|
| `No LLM providers configured` | `server/data/settings.json` eksik veya hiç provider `enabled` değil | Ayarlar modalından provider ve model ekleyin, anahtar girin. |
| `No Serper API keys configured` | `serper.keys` boş | Ayarlar > Advanced > Serper Keys ekleyin. |
| `429` sürekli | Rate limit veya smart routing blok | Farklı provider/model ekleyin, key sayısını artırın, bekleyin. |
| Frontend `/api` 404 | Backend çalışmıyor veya proxy hatalı | `server/` çalıştırıldığından emin olun; `vite.config.ts` proxy kontrol edin. |
| `Module not found` (backend) | `.js` import uzantısı unutulmuş | Node.js backend'de import yolları `.js` ile bitmeli. |
| Derleme hatası `noUnusedLocals` | Kullanılmayan değişken/import | Silin veya `// eslint-disable` değil, gerçekten kullanılmayanı kaldırın. |

---

## 11. İletişim ve Referanslar

- **API dokümantasyonu**: `docs/API.md`
- **Ajan stratejisi planı**: `docs/agent-strategy.md`
- **Deep depth preset planı**: `docs/deep-depth-presets-plan.md`
- **Ayarlar modalı yeniden tasarım planı**: `docs/settings-modal-redesign-plan.md`
- **README** (kullanıcıya yönelik): `README.md` (şu anda Vite template açıklaması; proje özgü bilgi eklenebilir).
- **Bu dosyayı güncelle**: Eğer proje yapısı, teknoloji yığını veya kritik kurallar değişirse bu `AGENTS.md` dosyasını da güncelleyin. Ayrıntılı kural için 0. ve 12. bölümlere bakın.

---

## 12. Son Not

ATHENA-001, hızlı bir demo değil; aktif olarak geliştirilen, çok provider'lı, akıllı yönlendirmeli, uzun süreli işleri destekleyen bir araştırma asistanı projesidir. Kod değişikliği yaparken:

- **Minimal değişiklik** yapın.
- **Mevcut konvansiyonları** takip edin.
- **Testleri çalıştırın**.
- **API anahtarlarını ve kişisel ayarları asla commit etmeyin**.
- Yeni özellik eklerken önce **Node.js backend**'i düşünün; Python backend legacy'dir ve yalnızca özel istek üzerine değiştirilmelidir.
- **Ve en önemlisi**: her değişiklikten sonra bu `AGENTS.md` dosyasını da gözden geçirin; eski, eksik veya çelişkili bilgi bırakmayın.
- **Kullanıcıya değişiklik özetini gösterin**: `AGENTS.md` güncellendikten sonra değişiklikleri kullanıcıya gösterin, ardından commit ve push yapın.
