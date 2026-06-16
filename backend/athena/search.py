import re
import httpx
from .config import settings
from .schemas import SearchResult

SERPER_ENDPOINTS = {
    "search": "search",
    "image": "images",
    "videos": "videos",
    "news": "news",
    "places": "places",
    "shopping": "shopping",
    "scholar": "scholar",
    "patents": "patents",
    "autocomplete": "autocomplete",
}


def _normalize(items: list[dict], type: str) -> list[SearchResult]:
    out: list[SearchResult] = []
    for i, item in enumerate(items):
        title = item.get("title") or item.get("name", "")
        url = item.get("link") or item.get("url", "")
        snippet = item.get("snippet") or item.get("description", "")
        date = item.get("date") or item.get("publishedAt", "") or item.get("publicationDate", "")

        if type == "image":
            url = item.get("imageUrl") or item.get("link", "")
            snippet = item.get("source") or snippet
        elif type == "places":
            snippet = f"{item.get('address', '')} | Rating: {item.get('rating', 'N/A')} ({item.get('reviews', 0)} reviews)"
        elif type == "shopping":
            snippet = f"${item.get('price', 'N/A')} - {item.get('source', '')} - {snippet}"
        elif type == "videos":
            snippet = f"{item.get('channel', '')} | {item.get('views', '')} views | {item.get('duration', '')} - {snippet}"
        elif type == "news":
            snippet = f"[{item.get('source', '')}] {snippet}"
        elif type == "autocomplete":
            title = item
            url = ""
            snippet = ""

        if title or url:
            out.append(SearchResult(id=i + 1, title=str(title), url=str(url), snippet=str(snippet) if snippet else None, date=str(date) if date else None))
    return out


async def fetch_results(query: str, num: int = 7, type: str = "search") -> tuple[list[SearchResult], str]:
    num = max(3, min(12, num))

    if type == "webpage":
        return await fetch_webpage(query)

    endpoint = SERPER_ENDPOINTS.get(type, "search")
    url = f"https://google.serper.dev/{endpoint}"

    headers = {
        "X-API-KEY": settings.next_serper_key(),
        "Content-Type": "application/json",
    }
    payload = {"q": query, "gl": "us", "hl": "en", "num": num}

    async with httpx.AsyncClient(timeout=30) as client:
        resp = await client.post(url, headers=headers, json=payload)
        resp.raise_for_status()
        data = resp.json()

    if type == "autocomplete":
        items = data.get("suggestions", [])
    elif type == "image":
        items = data.get("images", [])
    elif type == "videos":
        items = data.get("videos", [])
    elif type == "news":
        items = data.get("news", [])
    elif type == "places":
        items = data.get("places", [])
    elif type == "shopping":
        items = data.get("shopping", [])
    else:
        items = data.get("organic", [])

    results = _normalize(items, type)
    query_text = data.get("searchParameters", {}).get("q", query)
    return results, query_text


async def fetch_webpage(url: str) -> tuple[list[SearchResult], str]:
    try:
        async with httpx.AsyncClient(timeout=15, follow_redirects=True) as client:
            resp = await client.get(url, headers={
                "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
            })
            resp.raise_for_status()
            html = resp.text

        text = re.sub(r"<script[^>]*>.*?</script>", "", html, flags=re.DOTALL | re.IGNORECASE)
        text = re.sub(r"<style[^>]*>.*?</style>", "", text, flags=re.DOTALL | re.IGNORECASE)
        text = re.sub(r"<[^>]+>", " ", text)
        text = re.sub(r"\s+", " ", text).strip()
        text = re.sub(r"\n\s*\n", "\n", text)
        text = text[:8000]

        if not text.strip():
            return [], url

        from urllib.parse import urlparse
        domain = urlparse(url).netloc.replace("www.", "")

        return [SearchResult(id=1, title=f"Content from {domain}", url=url, snippet=text[:500], date=None)], url

    except Exception as e:
        return [SearchResult(id=1, title="Failed to fetch", url=url, snippet=str(e), date=None)], url
