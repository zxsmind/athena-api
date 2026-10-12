/**
 * The search backends Athena knows about, in try order.
 *
 * This is data, not wizard logic: the setup wizard offers these, the config
 * command edits them, and the operator console lists them. It lives here rather
 * than in `cli/setup.ts` so the server can offer the same list without pulling
 * the interactive prompts into the API process.
 */
export interface SearchBackendChoice {
  id: string;
  label: string;
  needsZone: boolean;
  keyless?: boolean;
}

export const SEARCH_BACKEND_CHOICES: SearchBackendChoice[] = [
  { id: 'serper', label: 'Serper (Google SERP)', needsZone: false },
  { id: 'youcom', label: 'You.com web search', needsZone: false },
  { id: 'serpapi', label: 'SerpApi (Google engine)', needsZone: false },
  { id: 'tavily', label: 'Tavily search', needsZone: false },
  { id: 'linkup', label: 'Linkup search', needsZone: false },
  { id: 'brave', label: 'Brave web search', needsZone: false },
  { id: 'parallel', label: 'Parallel v1 search', needsZone: false },
  { id: 'octen', label: 'Octen web search', needsZone: false },
  { id: 'firecrawl', label: 'Firecrawl v2 search', needsZone: false },
  { id: 'exa', label: 'Exa search', needsZone: false },
  { id: 'brightdata', label: 'Bright Data SERP (Google)', needsZone: true },
  { id: 'serply', label: 'Serply Google search', needsZone: false },
  { id: 'valyu', label: 'Valyu web search', needsZone: false },
  { id: 'jina', label: 'Jina Reader search', needsZone: false },
  { id: 'freeserp', label: 'FreeSerp search (keyless, no key needed)', needsZone: false, keyless: true },
];
