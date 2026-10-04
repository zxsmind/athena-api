interface InlineToolCall {
  raw: string;
  query: string;
  queries?: string[];
}

/**
 * Recovers a tool call that a model wrote into its text body as JSON or XML
 * instead of using the native `tool_calls` field.
 *
 * This is only consulted for models declared in `settings.inlineToolCallModels`;
 * see `usesInlineToolCalls` in `provider-registry.ts`. The catalog cannot
 * describe an endpoint it has never seen, so the declaration is what keeps this
 * from firing on an ordinary answer that happens to contain a JSON object.
 */
function extractQuery(obj: unknown): string | null {
  if (!obj || typeof obj !== 'object') return null;
  const o = obj as Record<string, unknown>;
  const params = (o.parameters || o) as Record<string, unknown>;
  return (params.search_query || params.query || params.searchquery || params.q) as string | null;
}

export function parseInlineToolCall(content: string): InlineToolCall | null {
  const trimmed = content.trim();
  try {
    const parsed = JSON.parse(trimmed);
    const query = extractQuery(parsed);
    if (query) return { raw: trimmed, query };
  } catch { /* not pure JSON */ }

  const jsonRegex = /\{(?:[^{}]|(?:\{[^{}]*\}))*\}/g;
  let match: RegExpExecArray | null;
  while ((match = jsonRegex.exec(content)) !== null) {
    try {
      const parsed = JSON.parse(match[0]);
      const query = extractQuery(parsed);
      if (query) return { raw: match[0], query };
    } catch { continue; }
  }

  const xmlToolCallRegex = /<tool_call>[\s\S]*?<\/tool_call>/g;
  let xmlMatch: RegExpExecArray | null;
  while ((xmlMatch = xmlToolCallRegex.exec(content)) !== null) {
    const block = xmlMatch[0];
    const paramRegex = /<parameter=(\w+)>([\s\S]*?)<\/parameter>/g;
    const params: Record<string, unknown> = {};
    let paramMatch: RegExpExecArray | null;
    while ((paramMatch = paramRegex.exec(block)) !== null) {
      const [, key, value] = paramMatch;
      try { params[key] = JSON.parse(value.trim()); }
      catch { params[key] = value.trim(); }
    }
    const query = extractQuery(params);
    if (query) return { raw: block, query };
    if (Array.isArray(params.queries) && (params.queries as unknown[]).length > 0) {
      const validQueries = (params.queries as unknown[]).filter((q): q is string => typeof q === 'string' && q.trim() !== '');
      if (validQueries.length > 0) return { raw: block, query: validQueries[0], queries: validQueries };
    }
  }

  /* Fallback: unclosed <tool_call> (some models omit </tool_call>) */
  const unclosedMatch = content.match(/<tool_call>([\s\S]*)$/);
  if (unclosedMatch) {
    const block = '<tool_call>' + unclosedMatch[1];
    const paramRegex = /<parameter=(\w+)>([\s\S]*?)<\/parameter>/g;
    const params: Record<string, unknown> = {};
    let paramMatch: RegExpExecArray | null;
    while ((paramMatch = paramRegex.exec(block)) !== null) {
      const [, key, value] = paramMatch;
      try { params[key] = JSON.parse(value.trim()); }
      catch { params[key] = value.trim(); }
    }
    const query = extractQuery(params);
    if (query) return { raw: block, query };
    if (Array.isArray(params.queries) && (params.queries as unknown[]).length > 0) {
      const validQueries = (params.queries as unknown[]).filter((q): q is string => typeof q === 'string' && q.trim() !== '');
      if (validQueries.length > 0) return { raw: block, query: validQueries[0], queries: validQueries };
    }
  }

  return null;
}