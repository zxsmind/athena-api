import { color } from './colors.js';

/**
 * Block-letter wordmark, six rows.
 *
 * Source rows are kept free of trailing spaces, so the rows are not all the
 * same length here. `pad()` pads every row to the widest one at print time,
 * because a row that is short by even one space reads as broken art.
 */
const BANNER_LINES = [
  '█████╗    ████████╗ ██╗   ██╗ ████████╗ ███╗  ██╗ █████╗',
  '██╔══██╗  ╚══██╔══╝ ██║   ██║ ██╔═════╝ ████╗ ██║ ██╔══██╗',
  '███████║     ██║    █████████ █████╗    ██╔██╗██║ ███████║',
  '██╔══██║     ██║    ██║   ██║ ██╔══╝    ██║╚██╗█║ ██╔══██║',
  '██║  ██║     ██║    ██║   ██║ ███████╗  ██║ ╚███║ ██║  ██║',
  '╚═╝  ╚═╝     ╚═╝    ╚═╝   ╚═╝ ╚══════╝  ╚═╝  ╚══╝ ╚═╝  ╚═╝',
] as const;

/** Widest row, which every printed row is padded to. */
const BANNER_WIDTH = Math.max(...BANNER_LINES.map((line) => line.length));

/** The rows exactly as they are written out. Exported for tests. */
export const bannerLines: readonly string[] = BANNER_LINES.map((line) => line.padEnd(BANNER_WIDTH, ' '));

export const bannerWidth = BANNER_WIDTH;

/** Wordmark printed once per command, with a subtitle or the tagline below. */
export function banner(subtitle?: string): void {
  process.stdout.write('\n');
  for (const line of bannerLines) {
    process.stdout.write(`${color.cyan(line)}\n`);
  }
  process.stdout.write(`\n ${color.dim(subtitle ?? 'evidence-based web research API')}\n`);
  process.stdout.write('\n');
}