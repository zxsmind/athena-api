# Sohbet Özeti — ATHENA-001

> **Historical note:** This is retained as a dated conversation summary. It is not the current architecture or API authority; use `docs/README.md` for the maintained document map.

> Başlangıç: Deep low mode'da model HTTP 400 hatası veriyordu (tool-round-1 crash).
> Bitiş: Derin bir teşhis raporu ile deep mod'un tüm kalite sorunları masaya yatırıldı.

---

## 1. İlk Sorun: Gemini 3.x HTTP 400 (thoughtSignature)

Deep low mode (gemini-3.1-flash-lite) Round 0 çalışıyor ama Round 1'de HTTP 400 dönüyordu.
Hata: `"Function call is missing a thought_signature in functionCall parts."`

**Çözüm (4 değişiklik, 54 test passed):**

- `llm.ts:78` — `convertToGeminiBody()`: tool/function response `role: 'user'` → `role: 'function'`
- `llm.ts:91` — `convertToGeminiBody()`: `functionCall` part'ına `thoughtSignature` ekle
- `llm.ts:230` — `normalizeGeminiResponse()`: response'dan `thoughtSignature` yakala, `thought_signature` olarak sakla
- `llm.ts:673` — `tryProviderStream` Gemini SSE handler: streaming'den `thoughtSignature` yakala
- `llm.ts:172` — `parseNonSseGeminiResponse`: non-SSE fallback'te `thoughtSignature` yakala

**Sonuç:** Gemini 3.x tool calling çalışır hale geldi. Deploy edilmedi.

---

## 2. İkinci Sorun: Deep Low 3 Search'te Duruyor

Kullanıcı: "deep low 3 search yapıyor ve duruyor, instant daha fazla yapıyor."

**Yanlış teşhis (benim ilk tahminim):** Per-round limit, cooldown, notebook cadence, prompt farkı.

**Kullanıcının düzeltmesi:** Per-round limit zaten kaldırılacaktı, kaldırılmamış. Prompt'a "do not write final answer until..." eklemek aptalca.

**Doğru çözüm:**

- `engine.ts:392-393`: Per-round limit (`maxSearchesThisRound`/`maxFetchesThisRound`) **tamamen kaldırıldı**. Artık `budget.remainingCredits` kullanılıyor. `maxSearchesPerRound`/`maxFetchesPerRound` alanları struct'ta loglama için duruyor.
- `depth-presets.ts:140`: `depthBehaviorBlock`'tan `"Per round target"` satırı silindi.
- `depth-presets.ts:34`: Low `notebookCadenceRawBlocks` 2→4 (model daha geç notebook yazar, daha çok search yapar).
- `AGENTS.md` güncellendi: per-round limit kullanılmadığı notu eklendi.
- Build + 54 test passed.

---

## 3. Git Remote Yapılandırması

Remote origin: `ubuntu@129.151.245.192:/srv/git/athena.git` (bare repo).

Kullanıcı loki-002 projesi için de aynı yapıyı kurmak istedi:
- `/srv/git/loki.git` oluşturuldu (bare repo)
- ATHENA-001'deki deploy sistemi mimarisi açıklandı

---

## 4. AGENTS.md Template

`templates/AGENTS.template.md` oluşturuldu — projeye özgü içerik barındırmayan, sadece genel kuralları (bölüm 0: güncelleme zorunluluğu, bölüm 6.1: kod kuralları, bölüm 7: güvenlik, bölüm 12: son not) içeren şablon.

---

## 5. Deep Mod Teşhis Raporu (En Önemli Kısım)

`docs/deep-mode-teşhis-raporu.md` yazıldı. Kapsamlı analiz, kod değişikliği yok.

### Bulgular:

#### Sorun A — Query Kalitesi
Model "Dolar kaç tl 4060 ti fiyat amd en son kart" gibi tek query'ye her şeyi dolduruyor.

- **Kök neden 1:** `types.ts:42-47` — Tool'da hem `search_query` (string) hem `queries` (array) var. Model array kullanmak yerine her şeyi tek string'e sığdırıyor.
- **Kök neden 2:** `prompts.ts:49-54` — Query stratejisi 75 satırlık DEEP_SYSTEM_PROMPT içinde 49. satırda gömülü, model görmüyor.
- **Kök neden 3:** `prompts.ts:9` vs `prompts.ts:49-54` — Instant mode 1 satırda "compact retrieval phrases" derken, deep 6 satır anlatıp modelin kafasını karıştırıyor.

#### Sorun B — Erken Durdurma
Model 2-4 search yapıp "kapsamlı araştırmalar sonucunda..." diyerek cevap veriyor.

- **Kök neden 1 (en kritik):** `engine.ts:84-85` — `deepResearchContextBlock` her round'da `"Write the final answer from the notebook, ledger, and source list."` gönderiyor. Model bunu "şimdi yaz" olarak yorumluyor.
- **Kök neden 2:** `prompts.ts:57-60` — "Final answer readiness" kriteri çok esnek. Model kendi kendine "no material unresolved gaps" kararı verebiliyor, bunu engelleyen hard guardrail yok.
- **Kök neden 3:** `engine.ts:120-125` — System message filter her round başında tüm system mesajlarını siliyor. Budget mesajı yeniden ekleniyor olsa da gereksiz bir silme/ekleme döngüsü.
- **Kök neden 4:** Notebook yazma zorunluluğu yok. Model notebook'a hiçbir şey yazmadan da cevap verebiliyor.

#### Sorun C — Depth Spesifik
| Depth | Budget | Kullanılan | Sorun |
|-------|--------|------------|-------|
| Low | 20 | ~2 (%10) | Erken durma |
| Med | 35 | ~4 (%11) | Erken durma |
| High | 50 | ~4 + connection lost | Cooldown 20-40sn SSE'yi koparıyor |
| Ultra | 100 | ~4 + connection lost | Cooldown 60sn SSE'yi koparıyor |

#### Sorun D — Engine vs Model Ayrımı
Engine loop'u (`agenticResearchStream`) düzgün çalışıyor. Budget takibi, tool calling, round yönetimi doğru. **Sorun model'in loop'u erken sonlandırması.** Engine sadece model'in `kind: 'answer'` kararına uyuyor.

### İlgili Dosyalar (tam yol)
```
C:\Users\eryyk\Desktop\ATHENA-001\server\src\agent\prompts.ts
C:\Users\eryyk\Desktop\ATHENA-001\server\src\engine.ts
C:\Users\eryyk\Desktop\ATHENA-001\server\src\engine\types.ts
C:\Users\eryyk\Desktop\ATHENA-001\server\src\engine\depth-presets.ts
C:\Users\eryyk\Desktop\ATHENA-001\server\src\engine\notebook.ts
C:\Users\eryyk\Desktop\ATHENA-001\server\src\engine\research-ledger.ts
C:\Users\eryyk\Desktop\ATHENA-001\server\src\engine\cooldown.ts
C:\Users\eryyk\Desktop\ATHENA-001\server\src\engine\tool-parser.ts
```

---

## 6. Kullanıcının Son Sözü

"Çözüm adımlarına geçeriz" — çözüm bekleniyor, henüz başlanmadı.
