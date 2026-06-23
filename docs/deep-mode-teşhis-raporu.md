# Deep Mod — Detaylı Teşhis Raporu

---

## 1. Sorgu Kalitesi Sorunu (Query Quality)

**Semptom:** Model "Dolar kaç tl 4060 ti fiyat amd en son kart" gibi her şeyi tek query'ye dolduruyor ya da 1-2 kelimelik anlamsız query'ler üretiyor.

### Sebep 1A: Tool definition'daki `search_query` + `queries` ikilemi

`server/src/engine/types.ts:42-47`:
```typescript
search_query: { type: 'string', description: 'A compact search phrase for one evidence need.' },
queries: { type: 'array', items: { type: 'string' }, description: 'Multiple compact search phrases...' },
```

Tool'da **2 farklı parametre var**: tek string (`search_query`) ve array (`queries`). Hiçbiri `required` değil. Model `queries` array'ini kullanmak yerine her şeyi `search_query`'ye tek string olarak sıkıştırıyor. Çünkü:
- Array parametresi tool calling'de daha karmaşık (model JSON içinde array üretmek zorunda)
- `description` alanında "break into separate queries" dense de model pratikte tek string'i tercih ediyor

### Sebep 1B: Prompt'ta query stratejisi gereksiz yere uzun ve gömülü

`server/src/agent/prompts.ts:49-54`:
```
**Query strategy**
- Use compact retrieval phrases, not conversational sentences.
- Preserve user-provided names, models, codes...
- Each query should target a distinct evidence need...
- Avoid repeating the same query...
- Choose the query language...
```

Bu 6 satır, **75 satırlık** DEEP_SYSTEM_PROMPT içinde 49. satırda gömülü. Model 75 satırı okurken ilk 20 satırı (Operating model + Notebook discipline) ve son 15 satırı (Final answer readiness + Citations) daha çok dikkate alıyor. Ortadaki "Query strategy" bölümü kayboluyor.

### Sebep 1C: Instant mode'un tersine DEEP'te query stratejisi net değil

`SYSTEM_PROMPT` (instant) line 9:
```
**Queries:** Compact retrieval phrases, not sentences. Keep entity names exactly as written.
```
— Kısa, öz, net. 1 satır.

`DEEP_SYSTEM_PROMPT` (deep) ise 6 satırda anlatıyor ama "compact retrieval phrases" dışında çok fazla ek talimat var. Modelin kafası karışıyor.

---

## 2. Erken Durdurma / Loop Kırmama Sorunu

**Semptom:** 2-4 search yapıp "kapsamlı araştırmalar sonucunda..." diyerek final answer veriyor.

### Sebep 2A: "Write the final answer" talimatı HER ROUND gönderiliyor (En kritik)

`server/src/engine.ts:84-85`:
```typescript
'Use write_notebook to append Markdown notes after digesting raw results...',
'Write the final answer from the notebook, ledger, and source list...',
```

Bu blok (`deepResearchContextBlock`) **her round'da** system message olarak modele gidiyor. Model bunu "şimdi final answer yaz" olarak yorumluyor olabilir. Özellikle notebook boş/az doluysa, model "notebook'ta bir şey var, yazayım" diyor.

### Sebep 2B: "Final answer readiness" kriteri çok esnek

`server/src/agent/prompts.ts:57-60`:
```
Write the final answer only when one of these is true:
- The notebook shows no material unresolved gaps
- Remaining gaps are explicitly unresolvable AND you have tried 2 strategies
- The research budget is exhausted
```

Model 2-3 search'ten sonra **kendiliğinden** "no material unresolved gaps" kararı verebiliyor. Bunu engelleyecek hard bir guardrail yok. Budget kontrolü **model karar verdikten sonra** (`kind: 'answer'`) çalışıyor, öncesinde değil.

### Sebep 2C: Round sonu budget mesajı siliniyor

`server/src/engine.ts:120-125`:
```typescript
if (messages.length > 1) {
    const baseSystem = messages[0];
    const rest = messages.slice(1).filter(msg => msg.role !== 'system');
    messages.length = 0;
    messages.push(baseSystem, ...rest);
}
```

Her round başında **tüm system mesajları** siliniyor (base prompt hariç). Bu, bir önceki round'da push edilen `[Budget: X credits remaining | Round Y]` mesajını da siliyor. Yerine yenisi konuyor (line 504-506), ama model round başında budget durumunu açıkça göremeyebiliyor.

**Ancak** tool mesajının içinde de budget bilgisi var (line 485-489):
```
[You have X search/fetch credits remaining...]
```

Bu tool mesajı filtreden etkilenmiyor (rolü 'tool', 'system' değil). Yani budget görünürlüğü sorunu yok, sadece gereksiz bir silme/ekleme döngüsü.

### Sebep 2D: Notebook zorlaması yok

Model notebook yazmadan da cevap verebiliyor. Hiçbir yerde "önce N round search yapmadan cevap verme" kuralı yok. `checkpointEveryRounds` High/Ultra için 2 olsa da bu sadece checkpoint için, model davranışını etkilemiyor.

---

## 3. Depth Spesifik Sorunlar

### Deep Low — 20 kredi, 2 search → cevap
- Budget'in sadece **%10'unu** kullanıyor
- `minCooldownMs: 5s` — cooldown sorun değil
- Sorun: Model kendini "bitmiş" hissediyor
- Notebook cadence eşiği 4 (yeni) → ama model 2 search'te cevap verdiği için notebook hiç yazılmıyor bile

### Deep Med — 35 kredi, 4 search → cevap
- Budget'in **%11'ini** kullanıyor
- Low ile aynı sorun, sadece biraz daha geç duruyor (rastgele)

### Deep High — 50 kredi, 4 search → connection lost
- 4 search → yağ gibi çalışıyor → sonra **connection lost**
- Connection lost'un olası nedenleri:
  1. **Cooldown 20-40s**: Browser/SSE bağlantısı 20+ saniye hiç event gelmeyince timeout atıyor. Cooldown boyunca SSE event gelmez, frontend bağlantıyı koparıyor.
  2. **Context overflow**: 50 kredi ile çok fazla tool mesajı birikebilir, provider'dan 413 (context too large) hatası geliyor olabilir.
  3. **Provider timeout**: Uzun cooldown + düşük temp (0.1) = model yavaş yanıt verebilir.

### Deep Ultra — 100 kredi, aynı sorun
- `minCooldownMs: 60s` (60 saniye bekleme) — 1 dakika boyunca hiçbir SSE event'i gelmez. Frontend bağlantıyı keser.
- Ultra'da bu tasarım gereği imkansıza yakın: 60sn cooldown + LLM çağrısı = kullanıcı 90+ saniye hiçbir şey görmez.

---

## 4. Sistem Akış Diyagramı (Problemin Görselleştirmesi)

```
[toolCallingRound START]
  ↓
Base prompt (sistem) + user mesajı
  ↓
System: [deepResearchContextBlock] ← "Write the final answer..." HER ROUND
  ↓
Model → tool_calls (2-4 search) veya answer
  ↓
Eğer search:
  → Serper API çağrısı
  → Cooldown (low:5-10s, med:10-15s, high:20-40s, ultra:60s)
  → Budget sil, yeni mesaj ekle
  → Round++
  ↓
Eğer answer:
  → Hemen döngüden çık → "done" eventi
  ↓
[MODEL KARAR VERDİ, engine sadece uyguluyor]
```

**Kritik nokta:** Engine'in loop'u düzgün çalışıyor. Sorun model'in çok erken `kind: 'answer'` dönmesi. Engine bunu engellemiyor çünkü prompt'ta "no material unresolved gaps" kontrolü tamamen modelin inisiyatifine bırakılmış.

---

## 5. İlgili Dosyalar (Tam Yol)

| Dosya | Rolü | Kritik Satırlar |
|-------|------|----------------|
| `server/src/agent/prompts.ts` | System promptları (SYSTEM_PROMPT + DEEP_SYSTEM_PROMPT) | L1-17 (instant), L19-75 (deep) |
| `server/src/engine.ts` | Ana agentik loop, tool calling round | L120-125 (system msg filter), L164-167 (low budget warning), L170-180 (deep context injection), L184-186 (tool seçimi), L262-278 (tool call arg parse), L392-394 (per-round task limit), L485-489 (budget note in tool msg), L504-506 (budget system msg), L614-618 (model answer handling), L751-787 (main loop) |
| `server/src/engine/types.ts` | Tool tanımları (web_search, fetch_url) | L37-51 (SEARCH_TOOL — `search_query` vs `queries` ikilemi), L53-65 (FETCH_URL_TOOL) |
| `server/src/engine/depth-presets.ts` | Depth preset değerleri | L27-88 (default presets), L98-131 (resolveResearchPreset), L133-154 (depthBehaviorBlock) |
| `server/src/engine/notebook.ts` | Notebook CRUD | L98-116 (truncateTail), L244-248 (notebookContext) |
| `server/src/engine/research-ledger.ts` | Query/fetch dedup ledger | L86-95 (duplicate tool messages), L97-116 (ledgerContextBlock) |
| `server/src/engine/cooldown.ts` | Cooldown hesaplama ve bekleme | L70-107 (computeCooldownMs), L109-135 (waitCooldown) |
| `server/src/engine/tool-parser.ts` | Inline XML/JSON tool call parsing | L14-72 (parseInlineToolCall) |

---

## 6. Temel Tespitler (Özet)

1. **Engine çalışıyor** — loop mekanizması, budget takibi, tool calling hepsi doğru. Sorun model'in loop'u erken sonlandırması.

2. **"Write the final answer" her round gidiyor** (`engine.ts:85`) — Modele her round "şimdi final answer yaz" talimatı veriliyor. Bu talimat sadece budget bittiğinde veya model bitti dediğinde gitmeli.

3. **Query stratejisi prompt'ta kayboluyor** — 75 satırlık prompt'ta 6 satır query stratejisi gözden kaçıyor. Model `queries` array'i yerine `search_query` string'ine her şeyi dolduruyor.

4. **Cooldown high/ultra'yı öldürüyor** — 20-60 saniyelik cooldown'larda SSE bağlantısı kopuyor. Frontend 20+ saniye event almazsa timeout atar.

5. **"No material unresolved gaps" guardrail'i yok** — Model kendi kendine "yeter" diyebiliyor. Protokolde bunu engelleyen hard bir kural yok.

6. **Budget-per-round önlemi daha yeni kaldırıldı** — Bu iyi bir değişiklikti, ama yeterli değil çünkü model zaten 2-4 search'te cevap vermeye karar veriyor.
