import katex from 'katex';
import MermaidBlock from '../MermaidBlock';
import { inlineMD } from './inlineMD';
import { escapeHtml } from '../../lib/chat-utils';
import type { Source } from '../../lib/api';

export function renderMarkdown(text: string, sources?: Source[], onDiagramClick?: (svg: string) => void) {
  const lines = text.split('\n');
  const nodes: React.ReactNode[] = [];
  let key = 0;
  let i = 0;

  while (i < lines.length) {
    const trimmed = lines[i].trim();
    if (!trimmed) { i++; continue; }

    const singleBlock = trimmed.match(/^\$\$(.+)\$\$$/) || trimmed.match(/^\\\[(.+)\\\]$/);
    if (singleBlock) {
      try {
        const html = katex.renderToString(singleBlock[1], { displayMode: true, throwOnError: false, strict: false });
        nodes.push(<div key={key++} className="math-block" dangerouslySetInnerHTML={{ __html: html }} />);
      } catch {
        nodes.push(<div key={key++} className="math-block">{singleBlock[1]}</div>);
      }
      i++;
      continue;
    }
    if (trimmed === '$$' || trimmed === '\\[') {
      const mathLines: string[] = [];
      const closer = trimmed === '$$' ? '$$' : '\\]';
      i++;
      while (i < lines.length && lines[i].trim() !== closer) {
        mathLines.push(lines[i]);
        i++;
      }
      if (i < lines.length) i++;
      const math = mathLines.join('\n');
      try {
        const html = katex.renderToString(math, { displayMode: true, throwOnError: false, strict: false });
        nodes.push(<div key={key++} className="math-block" dangerouslySetInnerHTML={{ __html: html }} />);
      } catch {
        nodes.push(<div key={key++} className="math-block">{math}</div>);
      }
      continue;
    }

    if (trimmed.startsWith('```')) {
      const lang = trimmed.slice(3).trim().toLowerCase();
      const codeLines: string[] = [];
      i++;
      while (i < lines.length && !lines[i].trim().startsWith('```')) {
        codeLines.push(lines[i]);
        i++;
      }
      if (i < lines.length) i++;

      const code = codeLines.join('\n');
      if (lang === 'mermaid') {
        nodes.push(<MermaidBlock key={key++} chart={code} onExpand={onDiagramClick} />);
      } else if (lang === 'latex' || lang === 'math') {
        const math = code.replace(/^\s*\$\$\s*/gm, '').replace(/\s*\$\$\s*$/gm, '');
        try {
          const html = katex.renderToString(math, { displayMode: true, throwOnError: false, strict: false });
          nodes.push(<div key={key++} className="math-block" dangerouslySetInnerHTML={{ __html: html }} />);
        } catch {
          nodes.push(<div key={key++} className="math-block">{math}</div>);
        }
      } else {
        nodes.push(
          <div key={key++} className="code-block-wrapper">
            {lang && <div className="code-block-lang">{lang}</div>}
            <pre className="code-block">
              <code dangerouslySetInnerHTML={{ __html: escapeHtml(code) }} />
            </pre>
          </div>
        );
      }
      continue;
    }

    if (/^#{1,6}\s/.test(trimmed)) {
      const level = trimmed.match(/^#+/)![0].length;
      const Tag = `h${Math.min(level + 1, 6)}` as keyof JSX.IntrinsicElements;
      nodes.push(<Tag key={key++} dangerouslySetInnerHTML={{ __html: inlineMD(trimmed.replace(/^#+\s*/, ''), sources) }} />);
      i++;
      continue;
    }

    if (/^>\s/.test(trimmed)) {
      nodes.push(<blockquote key={key++} dangerouslySetInnerHTML={{ __html: inlineMD(trimmed.replace(/^>\s*/, ''), sources) }} />);
      i++;
      continue;
    }

    if (/^(\*\*|__)(.+)\1$/.test(trimmed)) {
      const match = trimmed.match(/^(\*\*|__)(.+)\1$/);
      nodes.push(<p key={key++}><strong>{match![2]}</strong></p>);
      i++;
      continue;
    }

    if (/^[-*]\s/.test(trimmed)) {
      const items: React.ReactNode[] = [];
      while (i < lines.length && /^[-*]\s/.test(lines[i].trim())) {
        items.push(<li key={items.length} dangerouslySetInnerHTML={{ __html: inlineMD(lines[i].trim().replace(/^[-*]\s+/, ''), sources) }} />);
        i++;
      }
      nodes.push(<ul key={key++}>{items}</ul>);
      continue;
    }

    if (/^\d+\.\s/.test(trimmed)) {
      const items: React.ReactNode[] = [];
      while (i < lines.length && /^\d+\.\s/.test(lines[i].trim())) {
        items.push(<li key={items.length} dangerouslySetInnerHTML={{ __html: inlineMD(lines[i].trim().replace(/^\d+\.\s+/, ''), sources) }} />);
        i++;
      }
      nodes.push(<ol key={key++}>{items}</ol>);
      continue;
    }

    if (trimmed.startsWith('|') && trimmed.endsWith('|')) {
      const rows: string[][] = [];
      while (i < lines.length && lines[i].trim().startsWith('|') && lines[i].trim().endsWith('|')) {
        const row = lines[i].trim()
          .replace(/^\|/, '').replace(/\|$/, '')
          .split('|')
          .map(c => c.trim());
        if (!row.every(c => /^[-:]+$/.test(c))) {
          rows.push(row);
        }
        i++;
      }
      if (rows.length > 0) {
        const header = rows[0];
        const body = rows.slice(1);
        nodes.push(
          <div key={key++} style={{
            borderRadius: 12,
            overflow: 'hidden',
            background: 'rgba(var(--athena-accent-rgb), 0.03)',
            border: '0.5px solid var(--athena-border)',
            backdropFilter: 'blur(8px)',
            WebkitBackdropFilter: 'blur(8px)',
            margin: '8px 0',
          }}>
            <table style={{ borderCollapse: 'collapse', width: '100%', fontSize: 12 }}>
              <thead>
                <tr>
                  {header.map((cell, ci) => (
                    <th key={ci} style={{
                      padding: '10px 12px 10px 14px',
                      textAlign: 'left',
                      fontWeight: 600,
                      color: 'var(--athena-text)',
                    }} dangerouslySetInnerHTML={{ __html: inlineMD(cell, sources) }} />
                  ))}
                </tr>
              </thead>
              <tbody>
                <tr><td colSpan={header.length} style={{ height: '0.5px', background: 'var(--athena-border)', padding: 0 }} /></tr>
                {body.map((row, ri) => (
                  <tr key={ri} style={{ transition: 'background 120ms' }}
                    onMouseEnter={e => { (e.currentTarget as HTMLElement).style.background = 'rgba(var(--athena-accent-rgb), 0.04)'; }}
                    onMouseLeave={e => { (e.currentTarget as HTMLElement).style.background = 'none'; }}
                  >
                    {row.map((cell, ci) => (
                      <td key={ci} style={{
                        padding: '10px 12px 10px 14px',
                        color: 'var(--athena-text-2)',
                        borderBottom: ri < body.length - 1 ? '0.5px solid var(--athena-border)' : 'none',
                      }} dangerouslySetInnerHTML={{ __html: inlineMD(cell, sources) }} />
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        );
        continue;
      }
    }

    nodes.push(<p key={key++} dangerouslySetInnerHTML={{ __html: inlineMD(trimmed, sources) }} />);
    i++;
  }

  return nodes;
}
