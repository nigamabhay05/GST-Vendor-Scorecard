import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Contrast assertions over the design tokens.
 *
 * The palette is read out of styles.css rather than duplicated here, so this test fails
 * if someone changes a colour without checking it. Every flag colour has to stay legible
 * on the surfaces it is actually drawn on -- otherwise the one accessibility promise the
 * scorecard makes quietly stops being true, and nothing else would catch it.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const CSS = readFileSync(join(HERE, 'styles.css'), 'utf8');

function token(name: string): string {
  const match = new RegExp(`--color-${name}:\\s*(#[0-9a-fA-F]{6})`).exec(CSS);
  if (!match?.[1]) throw new Error(`Token --color-${name} not found in styles.css`);
  return match[1];
}

/** sRGB channel to linear light, per WCAG. */
function channel(value: number): number {
  const c = value / 255;
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

function relativeLuminance(hex: string): number {
  const r = Number.parseInt(hex.slice(1, 3), 16);
  const g = Number.parseInt(hex.slice(3, 5), 16);
  const b = Number.parseInt(hex.slice(5, 7), 16);
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

export function contrastRatio(foreground: string, background: string): number {
  const a = relativeLuminance(foreground);
  const b = relativeLuminance(background);
  const lighter = Math.max(a, b);
  const darker = Math.min(a, b);
  return (lighter + 0.05) / (darker + 0.05);
}

describe('contrast', () => {
  it('computes a known ratio correctly', () => {
    // Black on white is 21:1 by definition -- a check on the maths, not the palette.
    expect(contrastRatio('#000000', '#ffffff')).toBeCloseTo(21, 1);
    expect(contrastRatio('#ffffff', '#ffffff')).toBeCloseTo(1, 5);
  });

  it('meets AA for body and muted text on both surfaces', () => {
    for (const surface of ['sheet', 'field'] as const) {
      expect(contrastRatio(token('ink'), token(surface))).toBeGreaterThanOrEqual(4.5);
      expect(contrastRatio(token('ink-muted'), token(surface))).toBeGreaterThanOrEqual(4.5);
    }
  });

  it('meets AA for every flag colour on the sheet and on its own tint', () => {
    const flags = ['red', 'amber', 'green', 'grey'] as const;

    for (const flag of flags) {
      const colour = token(`flag-${flag}`);
      expect(
        contrastRatio(colour, token('sheet')),
        `--color-flag-${flag} on --color-sheet`,
      ).toBeGreaterThanOrEqual(4.5);
      expect(
        contrastRatio(colour, token(`flag-${flag}-tint`)),
        `--color-flag-${flag} on its own tint`,
      ).toBeGreaterThanOrEqual(4.5);
    }
  });

  it('meets AA for the accent on the sheet, and for white on the accent', () => {
    // The accent is used for links and for the text on primary buttons.
    expect(contrastRatio(token('accent'), token('sheet'))).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio('#ffffff', token('accent'))).toBeGreaterThanOrEqual(4.5);
  });

  it('keeps hairlines visible without being loud', () => {
    // Not a text contrast requirement, but a rule nobody can see is not a rule.
    const ratio = contrastRatio(token('rule'), token('sheet'));
    expect(ratio).toBeGreaterThan(1.2);
    expect(ratio).toBeLessThan(4.5);
  });
});
