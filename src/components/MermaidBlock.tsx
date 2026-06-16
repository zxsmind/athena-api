import { useState, useEffect, useRef, useCallback } from 'react';
import { useId } from 'react';

export default function MermaidBlock({ chart, onExpand }: { chart: string; onExpand?: (svg: string) => void }) {
  const containerId = useId().replace(/:/g, '');
  const ref = useRef<HTMLDivElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [svgHtml, setSvgHtml] = useState<string | null>(null);

  const handleClick = useCallback(() => {
    if (ref.current && !error) {
      onExpand?.(ref.current.innerHTML);
    }
  }, [onExpand, error]);

  useEffect(() => {
    let cancelled = false;

    async function renderDiagram() {
      try {
        const dark = document.documentElement.classList.contains('dark');
        const mermaidModule = await import('mermaid');
        const mermaid = mermaidModule.default;
        mermaid.initialize({
          startOnLoad: false,
          securityLevel: 'strict',
          theme: dark ? 'dark' : 'neutral',
          themeVariables: dark ? {
            fontFamily: '"Outfit", sans-serif',
            primaryColor: '#1e3058',
            primaryTextColor: '#e0e0f0',
            primaryBorderColor: '#3a5a8a',
            lineColor: '#5a7aaa',
            secondaryColor: '#182840',
            tertiaryColor: '#101828',
          } : {
            fontFamily: '"Outfit", sans-serif',
            primaryColor: '#e8ecf4',
            primaryTextColor: '#1a1a2e',
            primaryBorderColor: '#c0c8da',
            lineColor: '#8890a8',
            secondaryColor: '#f0f2f8',
            tertiaryColor: '#fafbfd',
          },
        });

        const { svg } = await mermaid.render(`mermaid-${containerId}`, chart);
        if (!cancelled) {
          const svgEl = new DOMParser().parseFromString(svg, 'image/svg+xml').documentElement as HTMLElement;

          svgEl.querySelectorAll('rect').forEach(r => {
            const w = parseFloat(r.getAttribute('width') || '0');
            const h = parseFloat(r.getAttribute('height') || '0');
            if (w > 20 && h > 20) {
              r.setAttribute('rx', '6');
              r.setAttribute('ry', '6');
            }
          });
          svgEl.querySelectorAll('polygon').forEach(p => p.setAttribute('stroke-linejoin', 'round'));

          setSvgHtml(svgEl.outerHTML);
          setError(null);
        }
      } catch (err: any) {
        if (!cancelled) {
          setError(err?.message || 'Mermaid diagram could not be rendered.');
        }
      }
    }

    setSvgHtml(null);
    setError(null);
    void renderDiagram();
    return () => { cancelled = true; };
  }, [chart, containerId]);

  return (
    <div ref={ref} className="mermaid-diagram" onClick={handleClick}>
      {error ? (
        <div className="mermaid-error">{error}</div>
      ) : svgHtml ? (
        <div dangerouslySetInnerHTML={{ __html: svgHtml }} />
      ) : (
        <div className="mermaid-loading">Loading diagram…</div>
      )}
    </div>
  );
}
