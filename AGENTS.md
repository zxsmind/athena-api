# ATHENA-001 — Agent Guide

> Bu doküman, ATHENA-001 projesinde çalışan AI ajanları (coding agent'ları) için kapsamlı bir bağlam ve çalışma rehberidir. İnsan kullanıcıya yönelik hızlı başlangıç değildir; `README.md` onun içindir. Buradaki bilgiler, kod değişikliği yapmadan önce bilinmesi gereken mimari, teknoloji yığını, konvansiyonlar ve dikkat edilmesi gereken kritik kuralları içerir.

---

## 0. AGENTS.md Güncelleme ve Doğruluk Kuralı

> **Bu dosyanın güncelliği ve doğruluğu, projenin sürdürülebilirliği için kritiktir.**

- Her kod değişikliği, mimari değişikliği veya yeni özellik eklenmesi sonrasında, bu `AGENTS.md` dosyasındaki ilgili bölümler gözden geçirilmeli ve gerekirse güncellenmelidir.
- Eğer bir değişiklik, bu dokümanda yazan bir kuralı, mimariyi, endpoint'i, ayar şemasını veya konvansiyonu değiştiriyorsa, **önce veya hemen sonra** doküman da düzeltilmelidir.
- Eksik, yanlış veya eski kalan bilgi bulunursa, proje taranmalı ve doğru haliyle değiştirilmelidir. Sadece kodu değiştirip dokümanı unutmak yasaktır.
- Yeni bir konvansiyon, güvenlik kuralı veya kritik davranış ortaya çıkarsa, bu dosyaya açıkça eklenmelidir.
- Bu dosya, sonraki ajanlar (ve insan katkıcılar) için tek kaynak doğru (single source of truth) kabul edilir; dolayısıyla her tutarsızlık derhal giderilmelidir.

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

### 2.3. Backend (Eski / Legacy)

| Teknoloji | Kullanım |
|-----------|----------|
| **Python 3.10** + **FastAPI** | Eski prototip backend (kaynak dosyaları şu anda dizinde yok) |
| **httpx** | Async HTTP istemcisi (eskiden) |
| **Pydantic Settings** | `.env` tabanlı yapılandırma (eskiden) |

> **Önemli:** Aktif backend Node.js/Express (`server/`) dizinidir. `backend/` dizini şu anda yalnızca `backend/settings.json` (ortak ayarlar), `backend/.env` (Python env kalıntısı) ve `backend/llm-errors.log` (log dosyası) ile `backend/__pycache__/main.cpython-310.pyc` (eski derleme kalıntısı) içerir. Eski `backend/main.py` ve `athena/` modül kaynak dosyaları mevcut çalışma alanında bulunmuyor. Yeni özellikler veya API'ler **Node.js backend** üzerine eklenir. Python kodu yalnızca açıkça istenirse değiştirilir.

### 2.4. Akıllı Yönlendirme (Smart Routing)

| Teknoloji | Kullanım |
|-----------|----------|
| **@mindbox/smart-routing-core** | Yerel monorepo paketi (`smart-routing-core/`) |
| **Kendi içinde TypeScript** | Rate limit takibi, fallback zinciri, key/model rotasyonu, "sticky-incumbent" politikası |

Bu paket, LLM çağrılarında birden fazla provider/key/model kombinasyonu arasında akıllıca geçiş yapar. 429, 401, 413, timeout gibi durumları öğrenir ve sonraki çağrılarda daha sağlıklı rotalar seçer.

> **Not:** `docs/settings-modal-redesign-plan.md` artık büyük ölçüde implemente edilmiştir; mevcut `SettingsModal.tsx` 5 sekme (General, Providers, Models, Advanced, API) içerir.

### 2.5. Veri Saklama

- **Sohbetler / Mesajlar**: `server/data/db.json` JSON dosyası (`db.ts`).
- **Araştırma işleri (jobs)**: Bellek içi (in-memory), sunucu yeniden başlayınca silinir.
- **Araştırma toplu işleri (batches)**: Bellek içi.
- **Ayarlar**: `backend/settings.json` (v2 şema), `settings-store.ts` tarafından yüklenir ve normalize edilir.

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
│   │   ├── ModeDropdown.tsx      # Instant / Deep mod seçimi
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
│   │   ├── engine.ts             # Agentic araştırma motoru (plan/search/analyze/synthesize)
│   │   ├── llm.ts                # LLM çağrıları, fallback, smart routing entegrasyonu
│   │   ├── search.ts             # Serper API ve web sayfası içeriği çekme
│   │   ├── settings.ts           # API response için settings dönüştürme katmanı
│   │   ├── settings-store.ts     # settings.json disk okuma/yazma, normalize, cache
│   │   ├── db.ts                 # JSON tabanlı sohbet/mesaj CRUD
│   │   ├── config.ts             # Public config, port, static URL'ler
│   │   ├── schemas.ts            # Paylaşılan TypeScript tipleri
│   │   ├── agent/prompts.ts      # System / synthesis / deep research promptları
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
├── backend/                      # Eski Python FastAPI backend (legacy) — kaynak dosyalar yok
│   ├── __pycache__/              # Eski derleme kalıntısı (örn. main.cpython-310.pyc)
│   ├── .env                      # Python backend env (gitignore)
│   ├── llm-errors.log            # LLM hata logları
│   └── settings.json             # Node.js backend ile paylaşılan ayarlar (gitignore'da)
│
├── docs/                         # Proje dokümanları
│   ├── API.md                    # API referansı (v2, Node backend)
│   ├── agent-strategy.md         # Ajan mimarisi v2 planı
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

`agenticResearchStream(query, history, onEvent, mode, options)` fonksiyonu, arama motorunun kalbidir.

1. **Plan / Analyze Aşaması**: LLM'e `web_search` ve `fetch_url` araçları verilir. Model, kullanıcı sorusunu alt sorulara böler ve arama yapar. Ayrı "Plan → Search → Analyze → Review → Synthesize" fazları henüz implemente edilmemiştir; tüm araç çağrısı ve analiz aynı `toolCallingRound` döngüsü içinde çalışır.
2. **Arama Aşaması**: `search.ts` üzerinden Serper.dev çağrılır; sonuçlar toplanır ve kaynaklar `[N]` index'leri atanır.
3. **Inline Tool Call Parsing**: Bazı modeller (Llama, Qwen) OpenAI `tool_calls` formatı yerine XML/JSON inline çıktı verebilir. `parseInlineToolCall()` bunları yakalar.
4. **Bütçe Denetimi**: Yalnızca **her araç çağrısı** (search/fetch) 1 kredi harcar. `maxCreditsPerQuery` aşılırsa yeni arama yapılmaz, döngü sonlanır. Sentez/plan için yapılan LLM çağrıları kredi harcamaz. Quick modda bütçe ayrıca sabit 6 ile sınırlandırılır.
5. **Sonuç Aşaması**: Model, son turda cevap metni ürettiyse bu metin doğrudan `done` olayıyla döner. Ayrı bir sentez/synthesis LLM çağrısı veya `SYNTHESIS_PROMPT` kullanımı yoktur; `SYNTHESIS_PROMPT` dosyada tanımlıdır ancak şu anda kullanılmıyor.
6. **Chat Modu**: Eğer model hiç araç kullanmadan doğrudan cevap verdiyse (örn. selamlaşma), aynı şekilde `done` olayıyla döner.

Modlar:
- **quick**: Kullanıcıya "Instant" olarak gösterilir. Dahili model rolü `instant`. Max 3 tur, hızlı cevap.
- **deep**: Dahili model rolü `deep`. Max 50 tur, daha kapsamlı ve çok kaynaklı araştırma.

> **Dikkat:** Ayarlarda bulunan `general.deepIterations` ve `research.maxFollowUpQueries` alanları şu anda `engine.ts` içinde aktif olarak kullanılmıyor; deep mod tur sayısı sabit 50, follow-up limiti bütçe ve tur sayısı tarafından dolaylı olarak sınırlanıyor. Bu ayarları devreye sokacak bir değişiklik yapmadan önce bu dokümanı ve ilgili kodu güncelleyin.

> **Not:** `engine.ts` artık sondaki yanıtı `{ type: 'token', text: answer }` olayı ve ardından `{ type: 'done', ... }` olayı şeklinde gönderiyor. `emitAnswer()` fonksiyonu, bitmiş yanıtı tek bir `token` olayı olarak yayınlar (kelime kelime stream değil). Frontend `onToken` handler'ı bu şekilde çalışır.

### 5.2. LLM Yönlendirme (`server/src/llm.ts`)

- `callLLM` (non-streaming) ve `callLLMStream` (streaming) fonksiyonları.
- Her çağrı bir `role` alabilir: `title`, `reasoning`, `instant`, `deep`.
- `resolveRoleTargetReferences()` ile `modelRouting` ayarlarından primary + fallback zinciri çözülür.
- Eğer hedef rol yoksa veya tüm hedefler başarısız olursa, tüm enabled provider'ların modelleri denenir.
- 429 rate limit, 401 auth, 413 context too large, timeout, stream interruption gibi durumlar için retry ve fallback mantığı vardır.
- Deep modda toplam 5 deneme (1 ilk deneme + 4 global retry) ve exponential backoff (2s, 4s, 8s, 16s) vardır.

> **Dikkat:** `reasoning` rolü ayarlarda tanımlı olsa da, şu anda `engine.ts` içinde doğrudan kullanılmıyor. Gelecekte ayrı bir analiz/reasoning aşaması eklenecekse bu rol devreye girecektir.

### 5.3. Smart Routing (`smart-routing-core`)

- `createSmartRoutingEngine()`.
- `selectRoute({ candidates, rotationPolicy })` → `sticky-incumbent` veya `balanced`.
- `recordOutcome({ leaseId, kind, observations })` → başarı/başarısızlık/rate-limit kaydı.
- Runtime'da öğrenilen limitler (learned capacity), 429 header'ları, retry-after, burst episode detection, provider pressure gibi kavramları vardır.

### 5.4. Ayarlar Sistemi (`settings-store.ts` + `settings.ts`)

Ayarlar `backend/settings.json` dosyasında saklanır. `settings-store.ts`:

- Eski v1 ayarları otomatik v2'ye normalize eder.
- 2 saniyelik cache tutar.
- `loadSettings()` ve `saveSettings()` export eder.

`settings.ts` ise API yanıtı için `keys` dizilerini döner (maskeleme yapılmaz; UI'da maskeleme `SettingsModal.tsx` içindedir).

Ayar şeması v2 ana bölümleri:
- `version`: Şema versiyonu (2).
- `port` / `host`: Sunucu portu ve bind adresi.
- `providers`: `groq`, `gemini`, `vercel`, `openrouter`, `custom` — her biri `enabled`, `keys`, `models`, `url`, `name`.
- `providerOrder`: Deneme sırası.
- `modelRouting`: Her rol için `primary` + `fallback` model referansları.
- `serper`: Arama API anahtarları.
- `research`: `maxCreditsPerQuery`, `maxFollowUpQueries`.
- `api`: `defaultMode`, `defaultMaxConcurrent`, `maxActiveJobs`, `maxActiveBatches`, `maxEventsPerJob`, `maxEventsPerBatch`, `maxRetentionMinutes`.
- `general`: `maxSources`, `deepIterations`, `thinkingStripPatterns`, `titleModel`.

### 5.5. API Endpoint'leri (Özet)

- `POST /search` → bir `research-jobs` oluşturur, `{ id }` döner. Frontend `GET /research-jobs/:id/events` ile SSE bağlanır.
- `GET /research-jobs/:id` → job durumunu ve sonucunu döner.
- `GET /research-jobs/:id/events` → SSE stream (status, step, token, sources, done, error).
- `POST /research-jobs/:id/cancel` → işi iptal eder.
- `GET/POST /research-batches` → toplu araştırma işleri.
- `GET /settings`, `PUT /settings` → ayarları oku/yaz.
- `GET /conversations`, `POST /conversations`, `GET/PUT /conversations/:id/messages`, `PUT /conversations/:id/rename`, `DELETE /conversations/:id`.
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

### 6.3. Backend Özel

- LLM çağrılarında `signal` (AbortSignal) her zaman dikkate alınır; kullanıcı iptal ettiğinde akış durmalı.
- `llm-errors.log` dosyasına 429, 400 ve 413 hataları kaydedilir; 401 hataları kaydedilmez (atlanır). Bu log dosyası gitignore'dadır.
- In-memory job/batch yönetiminde `MAX_JOBS` / `MAX_BATCHES` limitleri aşılırsa en eski kayıtlar silinir.
- `db.json` yazma işlemleri `withLock` ile seri hale getirilmiştir; race condition yoktur.

### 6.4. Smart Routing Core Özel

- `const` ile tanımlı fonksiyonlar ve utility fonksiyonlar tercih edilir.
- `satisfies` kullanımı yaygın.
- Node.js yerel `test` runner kullanılır (`node:test`).

---

## 7. Kritik Güvenlik ve Gizlilik Kuralları

> Bu bölüm **kesinlikle** dikkate alınmalıdır.

1. **API anahtarları asla frontend'e gitmez.** `backend/settings.json` içindeki `keys` dizileri `GET /settings` yanıtında döner, ancak UI `SettingsModal.tsx` içinde `maskSecret()` ile maskeleme yapar. Yine de anahtarlar istemciye ulaşır; bu bilerek yapılmış bir yerel uygulama tasarımıdır. Üretimde bu ayar endpoint'i daha fazla kısıtlanmalıdır.
2. **`backend/settings.json` ve `server/data/db.json` commitlenmez.** `.gitignore` içinde belirtilidir. **Asla** bu dosyalara gerçek API anahtarı yazıp commit yapmayın. Eğer yanlışlıkla yapılırsa kullanıcıya hemen bildirin.
3. **`.env` dosyaları gitignore'dadır.** Python backend için `backend/.env` var; Node.js backend `dotenv` kullanır ama şu anda aktif `.env` dosyası yoktur. Node.js backend `backend/settings.json`'den okur.
4. **Yeni provider entegrasyonu** yapılırken OpenAI-compatible chat completions formatına uygun olmalıdır. Gemini native formatı `normalizeGeminiResponse()` ile dönüştürülür.
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
- `SYSTEM_PROMPT`, `SYNTHESIS_PROMPT`, `DEEP_SYSTEM_PROMPT`.
- Prompt değişikliği yapıldığında hem quick hem deep modda test edilmelidir; citation formatı bozulmamalıdır.

### 8.5. Frontend CSS / Tema Değişikliği

- Renk, cam efekt, animasyon gibi tasarım değişiklikleri `src/index.css` içindeki CSS değişkenlerinden yapılır.
- Koyu mod için `.dark` selector'u kullanılır.
- MUI tema değişikliği gerekiyorsa `src/theme.ts` güncellenir.

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
| `No LLM providers configured` | `backend/settings.json` eksik veya hiç provider `enabled` değil | Ayarlar modalından provider ve model ekleyin, anahtar girin. |
| `No Serper API keys configured` | `serper.keys` boş | Ayarlar > Advanced > Serper Keys ekleyin. |
| `429` sürekli | Rate limit veya smart routing blok | Farklı provider/model ekleyin, key sayısını artırın, bekleyin. |
| Frontend `/api` 404 | Backend çalışmıyor veya proxy hatalı | `server/` çalıştırıldığından emin olun; `vite.config.ts` proxy kontrol edin. |
| `Module not found` (backend) | `.js` import uzantısı unutulmuş | Node.js backend'de import yolları `.js` ile bitmeli. |
| Derleme hatası `noUnusedLocals` | Kullanılmayan değişken/import | Silin veya `// eslint-disable` değil, gerçekten kullanılmayanı kaldırın. |

---

## 11. İletişim ve Referanslar

- **API dokümantasyonu**: `docs/API.md`
- **Ajan stratejisi planı**: `docs/agent-strategy.md`
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
