import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { dump, load } from 'js-yaml';

export type StructuredFormat = 'yaml' | 'json';

/** Format by file extension. `.yaml` and `.yml` parse as YAML. */
export function formatOf(path: string): StructuredFormat {
  return /\.ya?ml$/i.test(path) ? 'yaml' : 'json';
}

function parseText(text: string, path: string): unknown {
  if (formatOf(path) !== 'yaml') return JSON.parse(text) as unknown;
  /* An empty file means "no overrides". YAML rejects an empty document, so it
     is handled here instead of surfacing as a config error. */
  if (text.trim().length === 0) return {};
  return (load(text) ?? {}) as unknown;
}

/** Reads a YAML or JSON file by extension. A missing file reads as `{}`. */
export function readStructuredFile(path: string): unknown {
  if (!existsSync(path)) return {};
  try {
    const parsed = parseText(readFileSync(path, 'utf-8'), path);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch (error) {
    const format = formatOf(path) === 'yaml' ? 'YAML' : 'JSON';
    throw new Error(`Config file at ${path} is not valid ${format}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** Writes a value as YAML or JSON by extension, creating parent directories. */
export function writeStructuredFile(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const text = formatOf(path) === 'yaml'
    ? dump(value, { noRefs: true, lineWidth: 120 })
    : JSON.stringify(value, null, 2);
  writeFileSync(path, text, 'utf-8');
}
