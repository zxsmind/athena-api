from pydantic import BaseModel


class SearchRequest(BaseModel):
    query: str
    mode: str = "agent"
    history: list[dict] | None = None


class Source(BaseModel):
    title: str | None = None
    url: str
    domain: str
    snippet: str | None = None
    image: str | None = None


class SearchResult(BaseModel):
    id: int | None = None
    title: str
    url: str
    snippet: str | None = None
    date: str | None = None


class AgentStep(BaseModel):
    type: str
    query: str | None = None
    result_count: int | None = None
    note: str | None = None
    model: str | None = None
    reasoning: str | None = None


class SearchResponse(BaseModel):
    query: str
    answer: str
    sources: list[Source]
    steps: list[AgentStep] = []
    results_count: int = 0
    elapsed_ms: int = 0


class ErrorResponse(BaseModel):
    detail: str
