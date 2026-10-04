import ora from 'ora';
import { color, supportsColor } from './colors.js';

export { banner, bannerLines, bannerWidth } from './banner.js';
export { color, supportsColor };

export const spinner = ora;

/** Section heading: `── Title ─────────`. */
export function section(title: string): void {
  const fill = Math.max(3, 56 - title.length - 3);
  process.stdout.write(`\n${color.bold(color.cyan(`── ${title} `))}${color.dim('─'.repeat(fill))}\n`);
}

export function line(text = ''): void {
  process.stdout.write(`${text}\n`);
}

export function success(text: string): void {
  line(`${color.green('✔')} ${text}`);
}

export function failure(text: string): void {
  line(`${color.red('✖')} ${text}`);
}

export function warn(text: string): void {
  line(`${color.yellow('!')} ${text}`);
}

export function info(text: string): void {
  line(`${color.dim('·')} ${text}`);
}

export function kv(key: string, value: string): void {
  line(`  ${color.dim(key.padEnd(22))} ${value}`);
}

export function bullet(text: string): void {
  line(`  ${color.dim('·')} ${text}`);
}

/** Renders a header plus rows without a dependency; columns size to content. */
export function table(headers: string[], rows: string[][]): void {
  if (rows.length === 0) {
    line(color.dim('  (nothing to show)'));
    return;
  }
  const widths = headers.map((header, column) => Math.max(header.length, ...rows.map((row) => (row[column] ?? '').length)));
  const render = (cells: string[], paint: (text: string) => string) => paint(
    cells.map((cell, column) => (cell ?? '').padEnd(widths[column])).join('  '),
  );
  line(`  ${render(headers, (text) => color.bold(text))}`);
  line(`  ${color.dim(widths.map((width) => '─'.repeat(width)).join('  '))}`);
  for (const row of rows) line(`  ${render(row, (text) => text)}`);
}

/** Runs an async step behind a spinner, then clears the line before printing. */
export async function step<T>(text: string, work: () => Promise<T>): Promise<T> {
  const active = spinner({ text, discardStdin: false }).start();
  try {
    const result = await work();
    active.succeed(text);
    return result;
  } catch (error) {
    active.fail(text);
    throw error;
  }
}

export function bytes(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const exponent = Math.min(units.length - 1, Math.floor(Math.log(value) / Math.log(1024)));
  return `${(value / 1024 ** exponent).toFixed(exponent === 0 ? 0 : 1)} ${units[exponent]}`;
}

export function compactNumber(value: number): string {
  if (!Number.isFinite(value)) return '0';
  return new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 }).format(value);
}

export function money(value: number): string {
  return `$${value.toFixed(4)}`;
}
