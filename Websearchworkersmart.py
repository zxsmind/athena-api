# pip install requests

import json
import requests
import threading
from time import perf_counter
from concurrent.futures import ThreadPoolExecutor, as_completed

GROQ_API_KEY = "gskxfkErpW"
SERPER_API_KEY = "323923"

GROQ_URL = "https://api.groq.com/openai/v1/chat/completions"
SERPER_URL = "https://google.serper.dev/search"
MODEL = "llama-3.3-70b-versatile"

print_lock = threading.Lock()


def safe_print(text: str):
    with print_lock:
        print(text)


def ask_workers() -> int:
    print("Kaç paralel sorgu işlensin? (1-10, varsayılan 1): ", end="")
    raw = input().strip()
    if raw.isdigit() and 1 <= int(raw) <= 10:
        return int(raw)
    return 1


def read_queries_from_console() -> list[str]:
    print("\nArama sorgularını gir, her biri ayrı satırda.")
    print("Bitince boş satır bırak veya ===RUN=== yaz.\n")

    queries = []
    while True:
        try:
            line = input("Sorgu: ").strip()
        except EOFError:
            break

        if line == "===RUN===" or line == "":
            if queries:
                break
            continue

        if line:
            queries.append(line)
            print(f"  → Eklendi: {line}")

    return queries


def fetch_serper(query: str) -> dict:
    headers = {
        "X-API-KEY": SERPER_API_KEY,
        "Content-Type": "application/json",
    }
    payload = {"q": query, "gl": "us", "hl": "en"}
    resp = requests.post(SERPER_URL, headers=headers, json=payload, timeout=30)
    resp.raise_for_status()
    data = resp.json()
    data.setdefault("searchParameters", {"q": query})
    if "q" not in data["searchParameters"]:
        data["searchParameters"]["q"] = query
    return data


def clean_search_json(search_json: dict) -> dict:
    results = []
    for item in search_json.get("organic", []):
        title = item.get("title")
        url = item.get("link")
        if not title or not url:
            continue
        result = {
            "id": item.get("position"),
            "title": title,
            "url": url,
            "snippet": item.get("snippet"),
            "date": item.get("date"),
            "sitelinks": [],
        }
        for sl in item.get("sitelinks", []):
            sl_title = sl.get("title")
            sl_url = sl.get("link")
            if sl_title and sl_url:
                result["sitelinks"].append({"title": sl_title, "url": sl_url})
        results.append(result)

    people_also_ask = []
    for item in search_json.get("peopleAlsoAsk", []):
        question = item.get("question")
        snippet = item.get("snippet")
        if question and snippet:
            people_also_ask.append({
                "question": question,
                "answer_snippet": snippet,
                "source_title": item.get("title"),
                "source_url": item.get("link"),
            })

    return {
        "query": search_json.get("searchParameters", {}).get("q"),
        "results": results,
        "people_also_ask": people_also_ask,
    }


def build_prompt(search_json: dict) -> str:
    compact = clean_search_json(search_json)
    return f"""
Write a comprehensive, well-structured, technical answer from the web search evidence below.

Rules:
- Write directly as if answering the user's search intent in detail.
- Do not mention JSON, snippets, search results, or source-processing.
- Do not say phrases like "the search results show" or "based on the provided data".
- Organize the answer with a short intro paragraph, then use bullet points or numbered lists
  to cover key features, sub-topics, or technical details.
- Prefer official or primary sources when present.
- Do not invent facts.
- Be thorough: cover features, specs, pricing, use cases, or technical breakdown as relevant.
- Use inline citations like [1], [2], [3]. Citation numbers must exactly match the original result ids.
- Only include facts, numbers, and specifications that are explicitly stated
  in the search evidence. Do not fill gaps with background knowledge.
  If a detail is not in the evidence, omit it entirely.
- Never invent port counts, clock speeds, dB levels, core configurations,
  or benchmark numbers unless they appear verbatim in a snippet or people_also_ask answer.
- For pricing data, always mention the date of the source if available.
  Never present old prices as current without noting the date.
- Never fabricate retailer names, product model names, or prices
  that do not appear verbatim in the evidence.
- Never repeat the same product or model name more than once.
  If a model appears in multiple sources, mention it once and cite all sources together like [8][9][10].
- End with a single "Sources" section. List each source exactly once,
  in this format only — do NOT repeat the list or add URLs a second time:
  [n] Title — URL
- Output plain text only (no markdown headings, but bullet points and lists are encouraged).

User query:
{compact["query"]}

Search evidence:
{json.dumps(compact, ensure_ascii=False, indent=2)}
""".strip()


def extract_text_and_usage(data: dict):
    choices = data.get("choices", [])
    if not choices:
        return "", data.get("usage", {})
    message = choices[0].get("message", {})
    content = message.get("content") or ""
    return str(content).strip(), data.get("usage", {})


def send_groq_request(prompt: str, max_completion_tokens: int):
    headers = {
        "Authorization": f"Bearer {GROQ_API_KEY}",
        "Content-Type": "application/json",
    }
    payload = {
        "model": MODEL,
        "messages": [{"role": "user", "content": prompt}],
        "temperature": 0,
        "max_completion_tokens": max_completion_tokens,
        "stream": False,
    }
    started = perf_counter()
    resp = requests.post(GROQ_URL, headers=headers, json=payload, timeout=120)
    elapsed = perf_counter() - started
    resp.raise_for_status()
    data = resp.json()
    text, usage = extract_text_and_usage(data)
    return text, usage, elapsed, data


def condense_with_groq(search_json: dict) -> str:
    prompt = build_prompt(search_json)
    attempts = [1800, 2800]
    last_usage = {}
    last_elapsed = 0.0
    last_error = None
    text = ""

    for max_tokens in attempts:
        try:
            text, usage, elapsed, _ = send_groq_request(prompt, max_tokens)
            last_usage = usage
            last_elapsed = elapsed
            if text:
                output = "\n".join([
                    "=" * 100,
                    f"Sorgu: {search_json.get('searchParameters', {}).get('q', '(sorgu yok)')}",
                    f"Model: {MODEL} | Süre: {last_elapsed:.2f} sn",
                    f"Token kullanımı: {last_usage}",
                    "-" * 100,
                    text,
                    "",
                ])
                safe_print(output)
                return text
        except requests.HTTPError as e:
            last_error = e
            try:
                safe_print(f"HTTP hata ayrıntısı:\n{e.response.text}")
            except Exception:
                pass

    header = "\n".join([
        "=" * 100,
        f"Sorgu: {search_json.get('searchParameters', {}).get('q', '(sorgu yok)')}",
        f"Model: {MODEL} | Süre: {last_elapsed:.2f} sn",
        f"Token kullanımı: {last_usage}",
        "-" * 100,
    ])
    safe_print(header)

    if text:
        safe_print(text + "\n")
        return text
    if last_error:
        raise last_error
    safe_print("[BOŞ CEVAP]\n")
    return ""


def process_query(query: str, index: int, total: int) -> str:
    safe_print(f"[{index}/{total}] Aranıyor: {query}")
    try:
        search_json = fetch_serper(query)
        organic_count = len(search_json.get("organic", []))
        safe_print(f"  → [{index}/{total}] {organic_count} sonuç alındı: {query}")
    except requests.HTTPError as e:
        safe_print(f"  → Serper HTTP hatası ({query}): {e}")
        return ""
    except Exception as e:
        safe_print(f"  → Serper hatası ({query}): {e}")
        return ""

    try:
        return condense_with_groq(search_json)
    except requests.HTTPError as e:
        safe_print(f"Groq HTTP hatası ({query}): {e}")
    except Exception as e:
        safe_print(f"Groq hatası ({query}): {e}")
    return ""


if __name__ == "__main__":
    workers = ask_workers()
    queries = read_queries_from_console()

    if not queries:
        print("İşlenecek sorgu yok.")
        raise SystemExit(0)

    total = len(queries)
    mode = f"paralel ({workers} worker)" if workers > 1 else "sıralı"
    print(f"\nToplam sorgu: {total} | Mod: {mode}\n")

    wall_start = perf_counter()

    if workers == 1:
        for i, query in enumerate(queries, start=1):
            process_query(query, i, total)
    else:
        with ThreadPoolExecutor(max_workers=workers) as executor:
            futures = {
                executor.submit(process_query, query, i, total): query
                for i, query in enumerate(queries, start=1)
            }
            for future in as_completed(futures):
                try:
                    future.result()
                except Exception as e:
                    safe_print(f"Beklenmeyen hata: {e}")

    wall_elapsed = perf_counter() - wall_start
    print(f"Toplam süre: {wall_elapsed:.2f} sn ({mode})")
