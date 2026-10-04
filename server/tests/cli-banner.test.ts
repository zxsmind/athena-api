import { describe, expect, it } from 'vitest';
import { bannerLines, bannerWidth } from '../src/cli/banner.js';

describe('banner wordmark', () => {
  it('spells ATHENA in six rows', () => {
    expect(bannerLines).toHaveLength(6);
  });

  it('gives every row the same width so the columns line up', () => {
    /* The art arrived with the top row two characters short, which reads as
       broken output. Widths must match exactly. */
    const widths = bannerLines.map((line) => line.length);
    expect(new Set(widths).size).toBe(1);
    expect(bannerWidth).toBe(bannerLines[0].length);
  });

  it('has no row that is shorter than the declared width', () => {
    for (const line of bannerLines) {
      expect(line.length).toBeGreaterThanOrEqual(bannerWidth);
    }
  });

  it('uses only block drawing characters and spaces', () => {
    for (const line of bannerLines) {
      expect(line).toMatch(/^[█╗╝║╔╚═ ]+$/);
    }
  });

  it('ends the final row with the closing A', () => {
    expect(bannerLines[5].trimEnd().endsWith('╚═╝')).toBe(true);
  });
});