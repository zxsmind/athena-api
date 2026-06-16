import json
import httpx
from fastapi import FastAPI, HTTPException, Query
from fastapi.responses import StreamingResponse, JSONResponse
from fastapi.middleware.cors import CORSMiddleware

from athena.config import settings
from athena.schemas import SearchRequest, SearchResponse
from athena.engine import agentic_research

app = FastAPI(title="ATHENA-001", version="0.2.0")


@app.exception_handler(Exception)
async def global_exception_handler(request, exc):
    import traceback
    traceback.print_exc()
    return JSONResponse(
        status_code=500,
        content={"detail": str(exc), "type": type(exc).__name__},
    )


app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173", "http://localhost:5174", "http://localhost:5175"],
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/health")
async def health():
    return {"status": "ok"}


@app.post("/search")
async def search(req: SearchRequest):
    if not req.query.strip():
        raise HTTPException(status_code=400, detail="Query is required")
    if not settings.groq_api_keys or not settings.serper_api_keys:
        raise HTTPException(status_code=503, detail="API keys not configured")

    async def _stream():
        try:
            result = await agentic_research(req.query, history=req.history)
            yield f"event: done\ndata: {result.model_dump_json()}\n\n"
        except Exception as e:
            import traceback
            traceback.print_exc()
            yield f"event: error\ndata: {json.dumps({'message': str(e)})}\n\n"

    return StreamingResponse(
        _stream(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",
        },
    )


@app.get("/autocomplete")
async def autocomplete(q: str = Query(..., min_length=2)):
    async with httpx.AsyncClient(timeout=3) as client:
        resp = await client.get(
            "https://suggestqueries.google.com/complete/search",
            params={"client": "chrome", "q": q},
            headers={"User-Agent": "Mozilla/5.0"},
        )
        resp.raise_for_status()
        data = resp.json()
    items = data[1] if isinstance(data, list) and len(data) > 1 and isinstance(data[1], list) else []
    return {"suggestions": items[:6]}


if __name__ == "__main__":
    import uvicorn
    uvicorn.run("main:app", host=settings.host, port=settings.port, reload=True)
