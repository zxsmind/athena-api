import json
import httpx
from .config import settings
from .schemas import SearchResult


async def synthesize_answer(
    query: str,
    results: list[SearchResult],
    model: str | None = None,
) -> str:
    prompt = _build_prompt(query, results)
    model_name = model or settings.next_model()

    headers = {
        "Authorization": f"Bearer {settings.next_groq_key()}",
        "Content-Type": "application/json",
    }
    payload = {
        "model": model_name,
        "messages": [{"role": "user", "content": prompt}],
        "temperature": 0,
        "max_completion_tokens": 2800,
        "stream": False,
    }

    async with httpx.AsyncClient(timeout=120) as client:
        resp = await client.post(settings.groq_url, headers=headers, json=payload)
        resp.raise_for_status()
        data = resp.json()

    choices = data.get("choices", [])
    if not choices:
        return ""
    message = choices[0].get("message", {})
    return (message.get("content") or "").strip()


def _build_prompt(query: str, results: list[SearchResult]) -> str:
    compact = {
        "query": query,
        "results": [
            {
                "id": r.id,
                "title": r.title,
                "url": r.url,
                "snippet": r.snippet,
                "date": r.date,
            }
            for r in results
        ],
    }

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
  or benchmark numbers unless they appear verbatim in a snippet.
- For pricing data, always mention the date of the source if available.
  Never present old prices as current without noting the date.
- Never fabricate retailer names, product model names, or prices
  that do not appear verbatim in the evidence.
- Never repeat the same product or model name more than once.
  If a model appears in multiple sources, mention it once and cite all sources together like [8][9][10].
- End with a single "Sources" section. List each source exactly once,
  in this format only:
  [n] Title — URL
- Output plain text only (no markdown headings, but bullet points and lists are encouraged).

User query:
{compact["query"]}

Search evidence:
{json.dumps(compact, ensure_ascii=False, indent=2)}
""".strip()
