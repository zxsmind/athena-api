import itertools
import os
from pydantic_settings import BaseSettings, SettingsConfigDict
from pathlib import Path


def _csv(val: str) -> list[str]:
    return [v.strip() for v in val.split(",") if v.strip()]


def _csv_default(val: str, default: list[str]) -> list[str]:
    return _csv(val) if val else default


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=str(Path(__file__).resolve().parent.parent / ".env"),
        env_file_encoding="utf-8",
        extra="ignore",
        case_sensitive=False,
    )

    # Groq
    GROQ_API_KEYS: str = ""
    GROQ_URL: str = "https://api.groq.com/openai/v1/chat/completions"
    GROQ_MODELS: str = ""

    # Gemini (OpenAI-compatible)
    GEMINI_API_KEYS: str = ""
    GEMINI_URL: str = "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions"
    GEMINI_MODELS: str = ""

    # Vercel AI Gateway
    VERCEL_GATEWAY_URL: str = ""
    VERCEL_GATEWAY_KEY: str = ""
    VERCEL_MODELS: str = ""

    # OpenRouter
    OPENROUTER_API_KEYS: str = ""
    OPENROUTER_URL: str = "https://openrouter.ai/api/v1/chat/completions"
    OPENROUTER_MODELS: str = ""

    # Custom OpenAI-compatible provider
    CUSTOM_API_KEYS: str = ""
    CUSTOM_URL: str = ""
    CUSTOM_MODELS: str = ""
    CUSTOM_NAME: str = "custom"

    # Serper
    SERPER_API_KEYS: str = ""
    SERPER_URL: str = "https://google.serper.dev/search"

    # General
    MAX_SOURCES: int = 8
    DEEP_ITERATIONS: int = 3
    HOST: str = "0.0.0.0"
    PORT: int = 8000

    # Provider routing (comma-separated, order = priority)
    PROVIDER_ORDER: str = "groq,gemini,vercel,openrouter,custom"

    # Thinking strip patterns (regex, comma-separated)
    THINKING_STRIP_PATTERNS: str = r"<think>.*?</think>,<thinking>.*?</thinking>"

    @property
    def groq_api_keys(self) -> list[str]:
        return _csv(self.GROQ_API_KEYS)

    @property
    def groq_models(self) -> list[str]:
        return _csv(self.GROQ_MODELS)

    @property
    def gemini_api_keys(self) -> list[str]:
        return _csv(self.GEMINI_API_KEYS)

    @property
    def gemini_models(self) -> list[str]:
        return _csv(self.GEMINI_MODELS)

    @property
    def vercel_models(self) -> list[str]:
        return _csv(self.VERCEL_MODELS)

    @property
    def openrouter_api_keys(self) -> list[str]:
        return _csv(self.OPENROUTER_API_KEYS)

    @property
    def openrouter_models(self) -> list[str]:
        return _csv(self.OPENROUTER_MODELS)

    @property
    def custom_api_keys(self) -> list[str]:
        return _csv(self.CUSTOM_API_KEYS)

    @property
    def custom_models(self) -> list[str]:
        return _csv(self.CUSTOM_MODELS)

    @property
    def custom_name(self) -> str:
        return self.CUSTOM_NAME.strip() or "custom"

    @property
    def serper_api_keys(self) -> list[str]:
        return _csv(self.SERPER_API_KEYS)

    @property
    def provider_order(self) -> list[str]:
        return _csv(self.PROVIDER_ORDER)

    @property
    def thinking_strip_patterns(self) -> list[str]:
        return _csv(self.THINKING_STRIP_PATTERNS)

    @staticmethod
    def _round_robin(items: list[str]) -> itertools.cycle:
        return itertools.cycle(items) if items else itertools.cycle([""])

    def _make_cycles(self):
        self._groq_cycle = self._round_robin(self.groq_api_keys)
        self._groq_model_cycle = self._round_robin(self.groq_models)
        self._gemini_cycle = self._round_robin(self.gemini_api_keys)
        self._gemini_model_cycle = self._round_robin(self.gemini_models)
        self._vercel_model_cycle = self._round_robin(self.vercel_models)
        self._openrouter_cycle = self._round_robin(self.openrouter_api_keys)
        self._openrouter_model_cycle = self._round_robin(self.openrouter_models)
        self._custom_cycle = self._round_robin(self.custom_api_keys)
        self._custom_model_cycle = self._round_robin(self.custom_models)
        self._serper_cycle = self._round_robin(self.serper_api_keys)

    def next_groq_key(self) -> str:
        return next(self._groq_cycle) if self.groq_api_keys else ""

    def next_groq_model(self) -> str:
        return next(self._groq_model_cycle) if self.groq_models else ""

    def next_gemini_key(self) -> str:
        return next(self._gemini_cycle) if self.gemini_api_keys else ""

    def next_gemini_model(self) -> str:
        return next(self._gemini_model_cycle) if self.gemini_models else ""

    def next_vercel_model(self) -> str:
        return next(self._vercel_model_cycle) if self.vercel_models else ""

    def next_openrouter_key(self) -> str:
        return next(self._openrouter_cycle) if self.openrouter_api_keys else ""

    def next_openrouter_model(self) -> str:
        return next(self._openrouter_model_cycle) if self.openrouter_models else ""

    def next_custom_key(self) -> str:
        return next(self._custom_cycle) if self.custom_api_keys else ""

    def next_custom_model(self) -> str:
        return next(self._custom_model_cycle) if self.custom_models else ""

    def next_serper_key(self) -> str:
        return next(self._serper_cycle) if self.serper_api_keys else ""


settings = Settings()
settings._make_cycles()