import asyncio
import json
import re
import time
from datetime import datetime
import httpx
import uuid
from .config import settings
from .search import fetch_results
from .schemas import SearchResponse, Source, AgentStep

OG_CACHE: dict[str, str | None] = {}

MAX_TURNS = 5

SEARCH_TYPES_DESC = """
- search (default): general web search
- news: latest news articles
- image: find images
- videos: find videos
- places: local businesses, addresses, ratings
- shopping: product prices, stores
- scholar: academic papers, citations
- patents: patent documents
- autocomplete: search suggestions, related queries
- webpage: extract all text content from a specific URL (pass URL in "query" param)
"""

WEB_SEARCH_TOOL = {
    "type": "function",
    "function": {
        "name": "web_search",
        "description": 'Search for information. Write specific, detailed queries: use exact phrases in quotes, include relevant technical terms, dates, and context. Avoid generic one-word queries.',
        "parameters": {
            "type": "object",
            "properties": {
                "query": {"type": "string", "description": 'Detailed search query with specific terms, use quotes for exact phrases'},
                "type": {"type": "string", "enum": ["search", "news", "image", "videos", "places", "shopping", "scholar", "patents", "autocomplete", "webpage"], "default": "search", "description": "Type of search"},
                "num_results": {"type": "integer", "description": "Number of results (3-12)", "minimum": 3, "maximum": 12},
            },
            "required": ["query", "type"],
        },
    },
}

SYSTEM_PROMPT = """You are ATHENA, an evidence-first research assistant.

Today is {date}. Current time: {time}.

You have a web_search tool with these search types:""" + SEARCH_TYPES_DESC + """
Write high-quality search queries. Use exact phrases in "quotes", include dates, model numbers, and specific context. Avoid single generic keywords.

Cite sources [1], [2] inline in the answer text. Do not add any source list or reference section of any kind after the answer. All citations must be inline only.
You can call web_search up to 4 times in a single response for faster results.
Do not include any internal reasoning or thinking in the answer.
After searching, provide your final answer directly. Do not mention the search process."""

PROVIDER_CONFIGS = []


def _init_providers():
    global PROVIDER_CONFIGS
    if PROVIDER_CONFIGS:
        return

    ctx = {
        "groq": 32000,
        "gemini": 1000000,
        "vercel": 100000,
        "openrouter": 100000,
        "custom": 100000,
    }

    for name in settings.provider_order:
        if name == "groq" and settings.groq_api_keys and settings.groq_models:
            PROVIDER_CONFIGS.append({
                "name": "groq",
                "url": settings.groq_url,
                "key_fn": settings.next_groq_key,
                "model_fn": settings.next_groq_model,
                "max_context": ctx["groq"],
            })
        elif name == "gemini" and settings.gemini_api_keys and settings.gemini_models:
            PROVIDER_CONFIGS.append({
                "name": "gemini",
                "url": settings.gemini_url,
                "key_fn": settings.next_gemini_key,
                "model_fn": settings.next_gemini_model,
                "max_context": ctx["gemini"],
            })
        elif name == "vercel" and settings.VERCEL_GATEWAY_URL and settings.VERCEL_GATEWAY_KEY and settings.vercel_models:
            PROVIDER_CONFIGS.append({
                "name": "vercel",
                "url": settings.VERCEL_GATEWAY_URL,
                "key_fn": lambda: settings.VERCEL_GATEWAY_KEY,
                "model_fn": settings.next_vercel_model,
                "max_context": ctx["vercel"],
            })
        elif name == "openrouter" and settings.openrouter_api_keys and settings.openrouter_models:
            PROVIDER_CONFIGS.append({
                "name": "openrouter",
                "url": settings.OPENROUTER_URL,
                "key_fn": settings.next_openrouter_key,
                "model_fn": settings.next_openrouter_model,
                "max_context": ctx["openrouter"],
            })
        elif name == "custom" and settings.custom_api_keys and settings.custom_models and settings.CUSTOM_URL:
            PROVIDER_CONFIGS.append({
                "name": settings.custom_name,
                "url": settings.CUSTOM_URL,
                "key_fn": settings.next_custom_key,
                "model_fn": settings.next_custom_model,
                "max_context": ctx["custom"],
            })


def _strip_thinking(text: str) -> str:
    if not text:
        return text
    for pattern in settings.thinking_strip_patterns:
        text = re.sub(pattern, "", text, flags=re.DOTALL | re.IGNORECASE)
    return text.strip()


def _parse_inline_tool(content: str) -> list[dict] | None:
    """Bazı modeller tool call'ı structured değil, içerikte metin olarak döndürür.
    Bunu yakalayıp tool_calls formatına çevir."""
    patterns = [
        r'\{\s*"type"\s*:\s*"function"\s*,\s*"name"\s*:\s*"([^"]+)"\s*,\s*"parameters"\s*:\s*\{',
        r'<function_calls>\s*<invoke\s+name="([^"]+)">',
        r'web_search\s*\(\s*query\s*[:=]\s*"([^"]+)"',
    ]
    for p in patterns:
        m = re.search(p, content, re.DOTALL)
        if m:
            break
    else:
        return None

    try:
        obj = re.search(r'\{\s*"type"\s*:\s*"function"[^}]+"parameters"\s*:\s*(\{(?:[^{}]|\{(?:[^{}]|\{(?:[^{}]|\{[^{}]*\})*\})*\})*\})', content, re.DOTALL)
        if obj:
            params = json.loads(obj.group(1))
            name_match = re.search(r'"name"\s*:\s*"([^"]+)"', content)
            name = name_match.group(1) if name_match else "web_search"
            normalized = {"query": "", "type": "search", "num_results": 7}
            for k, v in params.items():
                k_clean = k.lower().replace(" ", "_").replace("-", "_")
                if k_clean in ("query", "q", "searchquery", "search_query"):
                    normalized["query"] = v
                elif k_clean in ("type", "search_type"):
                    normalized["type"] = v
                elif k_clean in ("num_results", "count", "max_results"):
                    normalized["num_results"] = int(v) if v else 7
            normalized["type"] = "search" if normalized.get("type") in ("function", "websearch", "web_search") else normalized.get("type", "search")
            return [{"id": str(uuid.uuid4()), "type": "function", "function": {"name": "web_search", "arguments": json.dumps(normalized)}}]
    except:
        pass

    return None


def _estimate_tokens(messages: list[dict]) -> int:
    total = 0
    for m in messages:
        content = m.get("content") or ""
        if isinstance(content, str):
            total += len(content)
        elif isinstance(content, list):
            for c in content:
                total += len(c.get("text", ""))
        tool_calls = m.get("tool_calls")
        if tool_calls:
            for tc in tool_calls:
                total += len(json.dumps(tc.get("function", {})))
    return total // 3


async def _call_llm(
    client: httpx.AsyncClient,
    messages: list[dict],
    tools: list[dict] | None = None,
    temperature: float = 0,
    max_tokens: int = 3200,
) -> dict:
    _init_providers()
    if not PROVIDER_CONFIGS:
        raise RuntimeError("No LLM providers configured")

    estimated = _estimate_tokens(messages)
    errors = []

    for cfg in PROVIDER_CONFIGS:
        if estimated > cfg["max_context"] * 0.9:
            errors.append(f"{cfg['name']}: context too large (est. {estimated})")
            continue

        for attempt in range(3):
            api_key = cfg["key_fn"]()
            model = cfg["model_fn"]()
            if not api_key or not model:
                errors.append(f"{cfg['name']}: no key/model (attempt {attempt+1})")
                continue

            try:
                payload = {
                    "model": model,
                    "messages": messages,
                    "temperature": temperature,
                    "max_completion_tokens": max_tokens,
                }
                if tools:
                    payload["tools"] = tools

                headers = {
                    "Authorization": f"Bearer {api_key}",
                    "Content-Type": "application/json",
                }

                resp = await client.post(cfg["url"], headers=headers, json=payload, timeout=120)

                if resp.status_code == 429:
                    await asyncio.sleep(min(2 ** attempt + 1, 10))
                    continue

                if resp.status_code == 400:
                    body = resp.json()
                    err_msg = str(body.get("error", {})).lower()
                    if "context_length" in err_msg or "context" in err_msg:
                        errors.append(f"{cfg['name']}: context exceeded")
                        break
                    errors.append(f"{cfg['name']}: 400 {err_msg[:100]}")
                    continue

                resp.raise_for_status()
                return resp.json()

            except httpx.TimeoutException:
                errors.append(f"{cfg['name']}: timeout")
                continue
            except Exception as e:
                errors.append(f"{cfg['name']}: {e}")
                continue

    raise RuntimeError(f"All providers failed: {'; '.join(errors)}")


async def _fetch_og_image(client: httpx.AsyncClient, url: str) -> str | None:
    if url in OG_CACHE:
        return OG_CACHE[url]
    try:
        resp = await client.get(url, timeout=5, follow_redirects=True, headers={
            "User-Agent": "Mozilla/5.0 (compatible; ATHENA/1.0)",
        })
        resp.raise_for_status()
        html = resp.text
        m = re.search(r'<meta\s+property="og:image"\s+content="([^"]+)"', html, re.IGNORECASE)
        if m:
            img = m.group(1)
            OG_CACHE[url] = img
            return img
        m = re.search(r'<meta\s+name="twitter:image"\s+content="([^"]+)"', html, re.IGNORECASE)
        if m:
            img = m.group(1)
            OG_CACHE[url] = img
            return img
    except Exception:
        pass
    OG_CACHE[url] = None
    return None


def _domain(url: str) -> str:
    try:
        from urllib.parse import urlparse
        return urlparse(url).netloc.replace("www.", "")
    except:
        return url


async def agentic_research(query: str, history: list[dict] | None = None) -> SearchResponse:
    start = time.perf_counter()
    steps: list[AgentStep] = []
    sources: list[Source] = []
    seen: set[str] = set()
    answer = ""
    last_content = ""

    async with httpx.AsyncClient(timeout=30) as client:
        now = datetime.now()
        sys_prompt = SYSTEM_PROMPT.format(
            date=now.strftime('%d.%m.%Y'),
            time=now.strftime('%H:%M %A'),
        )

        msgs = [{"role": "system", "content": sys_prompt}]
        if history:
            for h in history:
                if h.get("content"):
                    msgs.append({"role": h["role"], "content": h["content"]})
        msgs.append({"role": "user", "content": query})

        for turn in range(MAX_TURNS):
            data = await _call_llm(client, msgs, tools=[WEB_SEARCH_TOOL])
            msg = data["choices"][0]["message"]
            content = _strip_thinking(msg.get("content") or "")
            reasoning = msg.get("reasoning_content")
            if reasoning:
                steps.append(AgentStep(type="reason", note=reasoning[:500]))
            tool_calls = msg.get("tool_calls") or []

            if not tool_calls and content:
                inline_tc = _parse_inline_tool(content)
                if inline_tc:
                    tool_calls = inline_tc
                    content = ""

            if content:
                last_content = content

            if not tool_calls:
                answer = content
                break

            msgs.append({
                "role": "assistant",
                "content": content if content else None,
                "tool_calls": tool_calls,
            })

            search_tasks = []
            for tc in tool_calls:
                if tc["function"]["name"] != "web_search":
                    continue
                try:
                    args = json.loads(tc["function"]["arguments"])
                except:
                    args = {"query": query, "type": "search"}
                q = args.get("query", query)
                t = args.get("type", "search")
                n = int(args.get("num_results", 7))
                search_tasks.append((tc, q, t, n))

            async def _do_search(q, t, n):
                results, _ = await fetch_results(q, num=n, type=t)
                return results

            fetches = await asyncio.gather(*[_do_search(q, t, n) for _, q, t, n in search_tasks])

            for (tc, q, t, n), results in zip(search_tasks, fetches):
                new_results = [r for r in results if r.url not in seen]
                for r in new_results:
                    seen.add(r.url)

                steps.append(AgentStep(type=f"search:{t}", query=q, result_count=len(new_results)))

                id_start = len(sources) + 1
                tagged = []
                for i, r in enumerate(new_results):
                    tagged.append({"id": id_start + i, "title": r.title, "url": r.url, "snippet": r.snippet})
                    sources.append(Source(
                        title=r.title,
                        url=r.url,
                        domain=_domain(r.url),
                        snippet=r.snippet,
                    ))

                tool_result = f"YOUR SEARCH RESULTS (type: {t}, you searched \"{q}\", found {len(tagged)} results):\n{json.dumps(tagged, ensure_ascii=False, default=str)}"

                msgs.append({
                    "role": "tool",
                    "tool_call_id": tc["id"],
                    "content": tool_result,
                })

        if not answer and last_content:
            answer = last_content

        async with httpx.AsyncClient(timeout=10) as img_client:
            imgs = await asyncio.gather(*[_fetch_og_image(img_client, s.url) for s in sources], return_exceptions=True)
            for s, img in zip(sources, imgs):
                if isinstance(img, str):
                    s.image = img

    elapsed = int((time.perf_counter() - start) * 1000)
    return SearchResponse(
        query=query,
        answer=answer or "Could not generate an answer.",
        sources=sources,
        steps=steps,
        results_count=len(sources),
        elapsed_ms=elapsed,
    )