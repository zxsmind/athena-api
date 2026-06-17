import katex from 'katex';
import { sanitizeUrl } from '../../lib/chat-utils';
import type { Source } from '../../lib/api';

export function inlineMD(t: string, sources?: Source[]) {
  let html = t
    .replace(/\\\((.+?)\\\)/g, (_, m: string) => {
      try { return katex.renderToString(m, { throwOnError: false, strict: false }); }
      catch { return `\\(${m}\\)`; }
    })
    .replace(/\$([^$\s][^$]*[^$\s]|\S)\$/g, (full, m: string) => {
      if (/^\d/.test(m)) return full;
      try { return katex.renderToString(m, { throwOnError: false, strict: false }); }
      catch { return full; }
    })
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/(\*\*|__)(.+?)\1/g, '<strong>$2</strong>')
    .replace(/(\*|_)(.+?)\1/g, '<em>$2</em>')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, text, url) => `<a href="${sanitizeUrl(url)}" target="_blank" rel="noopener noreferrer">${text}</a>`);

  if (sources && sources.length > 0) {
    html = html.replace(/(?:\[|【)(\d+(?:\s*,\s*\d+)*)(?:†[^\]】]*)?(?:\]|】)/g, (match, nums) => {
      const indices = nums.split(/\s*,\s*/).map((n: string) => parseInt(n, 10) - 1);
      const valid = indices.filter((i: number) => i >= 0 && i < sources.length);
      if (valid.length === 0) return match;

      if (valid.length === 1) {
        const i = valid[0];
        const src = sources[i];
        const label = src.title || src.domain;
        const domain = src.domain;
        const snippet = (src.snippet || '').replace(/"/g, '&quot;').slice(0, 120);
        return `<a href="${src.url}" target="_blank" rel="noopener noreferrer" class="citation-badge" data-indices="${i}" data-domain="${domain}" data-title="${label.replace(/"/g, '&quot;')}" data-snippet="${snippet}">
          <img src="https://www.google.com/s2/favicons?domain=${domain}&sz=16" width="12" height="12" loading="lazy" onerror="this.src='data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 width=%2216%22 height=%2216%22 viewBox=%220 0 24 24%22 fill=%22none%22 stroke=%22%23999%22 stroke-width=%222%22%3E%3Ccircle cx=%2212%22 cy=%2212%22 r=%2210%22/%3E%3Cline x1=%222%22 y1=%2212%22 x2=%2222%22 y2=%2212%22/%3E%3Cpath d=%22M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z%22/%3E%3C/svg%3E'" />
          <span class="citation-label">${label}</span>
        </a>`;
      }

      const multiCount = valid.length - 1;
      const src = sources[valid[0]];
      const allDomains = valid.map((i: number) => sources[i]?.domain || '').join(',');
      const allTitles = valid.map((i: number) => (sources[i]?.title || sources[i]?.domain || '').replace(/"/g, '&quot;')).join(' || ');
      const allSnippets = valid.map((i: number) => (sources[i]?.snippet || '').replace(/"/g, '&quot;').slice(0, 120)).join(' ||| ');
      const allUrls = valid.map((i: number) => sources[i]?.url || '').join(',');
      const label = src.title || src.domain;
      const domain = src.domain;
      return `<a href="${src.url}" target="_blank" rel="noopener noreferrer" class="citation-badge multi" data-index="${valid[0]}" data-indices="${valid.join(',')}" data-domain="${allDomains}" data-title="${allTitles}" data-snippet="${allSnippets}" data-url="${allUrls}">
        <img src="https://www.google.com/s2/favicons?domain=${domain}&sz=16" width="12" height="12" loading="lazy" onerror="this.src='data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 width=%2216%22 height=%2216%22 viewBox=%220 0 24 24%22 fill=%22none%22 stroke=%22%23999%22 stroke-width=%222%22%3E%3Ccircle cx=%2212%22 cy=%2212%22 r=%2210%22/%3E%3Cline x1=%222%22 y1=%2212%22 x2=%2222%22 y2=%2212%22/%3E%3Cpath d=%22M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z%22/%3E%3C/svg%3E'" />
        <span class="citation-label">${label}</span>
        <span class="citation-multi-count">+${multiCount}</span>
      </a>`;
    });
  }

  return html;
}
