import React from 'react';
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

  function parseNestedList(start: number, ordered: boolean): { items: React.ReactNode[], next: number } {
    const items: React.ReactNode[] = [];
    const baseIndent = lines[start].length - lines[start].trimStart().length;
    let idx = start;

    while (idx < lines.length) {
      const line = lines[idx];
      const trimmed = line.trim();
      const indent = line.length - line.trimStart().length;

      if (!trimmed) { idx++; continue; }
      const marker = ordered ? /^\d+\.\s/ : /^[-*]\s/;
      if (!marker.test(trimmed)) break;
      if (idx > start && indent !== baseIndent) break;

      let content = trimmed.replace(ordered ? /^\d+\.\s+/ : /^[-*]\s+/, '');
      let taskChecked: boolean | null = null;
      const taskMatch = content.match(/^\[( |x|X)\]\s+(.*)/);
      if (taskMatch) {
        taskChecked = taskMatch[1] !== ' ';
        content = taskMatch[2];
      }

      idx++;

      let nested: React.ReactNode = null;
      while (idx < lines.length) {
        const nl = lines[idx];
        const nt = nl.trim();
        const ni = nl.length - nl.trimStart().length;
        if (!nt) { idx++; continue; }
        if (ni <= indent) break;
        if (/^[-*]\s/.test(nt)) {
          const sub = parseNestedList(idx, false);
          nested = <ul key={`n${idx}`} style={{ marginTop: 4, marginBottom: 4 }}>{sub.items}</ul>;
          idx = sub.next;
        } else if (/^\d+\.\s/.test(nt)) {
          const sub = parseNestedList(idx, true);
          nested = <ol key={`n${idx}`} style={{ marginTop: 4, marginBottom: 4 }}>{sub.items}</ol>;
          idx = sub.next;
        } else break;
      }

      if (taskChecked !== null) {
        items.push(
          <li key={items.length} style={{ listStyle: 'none' }}>
            <input type="checkbox" checked={taskChecked} readOnly disabled
              style={{ marginRight: 6, accentColor: 'var(--athena-accent)', transform: 'scale(0.85)', verticalAlign: 'middle' }} />
            <span dangerouslySetInnerHTML={{ __html: inlineMD(content, sources) }} />
            {nested}
          </li>
        );
      } else {
        items.push(
          <li key={items.length}>
            <span dangerouslySetInnerHTML={{ __html: inlineMD(content, sources) }} />
            {nested}
          </li>
        );
      }
    }
    return { items, next: idx };
  }

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
      const tagName = `h${Math.min(level + 1, 6)}`;
      const map: Record<string, React.ElementType> = { h2: 'h2', h3: 'h3', h4: 'h4', h5: 'h5', h6: 'h6' };
      const Tag = map[tagName] || 'h6';
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

    if (/^(\*{3,}|-{3,}|_{3,})\s*$/.test(trimmed)) {
      nodes.push(<hr key={key++} style={{ border: 'none', borderTop: '0.5px solid var(--athena-border)', margin: '16px 0' }} />);
      i++;
      continue;
    }

    const listMarker = trimmed.match(/^[-*]\s/) ? 'ul' : trimmed.match(/^\d+\.\s/) ? 'ol' : null;
    if (listMarker) {
      const result = parseNestedList(i, listMarker === 'ol');
      const Tag = listMarker === 'ol' ? 'ol' : 'ul';
      nodes.push(<Tag key={key++} style={{ margin: '4px 0' }}>{result.items}</Tag>);
      i = result.next;
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
