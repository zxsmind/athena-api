interface InlineToolCall {
  raw: string;
  query: string;
  queries?: string[];
}

function extractQuery(obj: any): string | null {
  if (!obj || typeof obj !== 'object') return null;
  const params = obj.parameters || obj;
  return params.search_query || params.query || params.searchquery || params.q || null;
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
    const params: Record<string, any> = {};
    let paramMatch: RegExpExecArray | null;
    while ((paramMatch = paramRegex.exec(block)) !== null) {
      const [, key, value] = paramMatch;
      try { params[key] = JSON.parse(value.trim()); }
      catch { params[key] = value.trim(); }
    }
    const query = extractQuery(params);
    if (query) return { raw: block, query };
    if (Array.isArray(params.queries) && params.queries.length > 0) {
      const validQueries = params.queries.filter((q: any) => typeof q === 'string' && q.trim());
      if (validQueries.length > 0) return { raw: block, query: validQueries[0], queries: validQueries };
    }
  }

  return null;
}
