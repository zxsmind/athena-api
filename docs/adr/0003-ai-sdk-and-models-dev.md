# ADR 0003 — AI SDK owns model transport; models.dev supplies capability data

**Status:** Adopted for the configured provider set.

## Decision

Model calls use AI SDK `generateText` and `streamText`. OpenAI-compatible provider URLs share `@ai-sdk/openai-compatible`; providers identified by models.dev as Google use the installed `@ai-sdk/google` provider. Athena does not hand-serialize provider requests, SSE chunks, or Gemini thought signatures.

Models.dev metadata is cached locally and refreshed only when the Models API/view is opened or explicitly refreshed. Known `tool_call: false` or `reasoning: false` entries are excluded from routes requiring those capabilities. Missing metadata stays eligible so custom model URLs remain usable.

## Consequences

The SDK normalizes tool calls and streaming; Smart Routing still owns route selection, provider health, key rotation, and fallback. Adding a provider with a non-OpenAI API requires its AI SDK provider package and a small adapter-factory registration. The catalog is advisory data and can be stale.
