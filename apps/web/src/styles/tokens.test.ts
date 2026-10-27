import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const css = readFileSync(new URL('./tokens.css', import.meta.url), 'utf8');

function token(name: string): string {
  const match = new RegExp(`--${name}:\\s*(#[0-9a-fA-F]{6})\\s*;`).exec(css);
  if (match?.[1] === undefined) throw new Error(`token --${name} is not a 6-digit hex color`);
  return match[1];
}

/** WCAG 2.x relative luminance. */
function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((offset) => {
    const channel = parseInt(hex.slice(offset, offset + 2), 16) / 255;
    return channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(foreground: string, background: string): number {
  const [light, dark] = [luminance(foreground), luminance(background)].sort((a, b) => b - a) as [
    number,
    number,
  ];
  return (light + 0.05) / (dark + 0.05);
}

/** WCAG AA for normal-size text; every foreground token may be used for labels. */
const AA_TEXT = 4.5;

const foregrounds = ['text-primary', 'text-secondary', 'action', 'warning', 'fossil'];
const surfaces = ['background', 'panel'];

describe('design token contrast', () => {
  for (const surface of surfaces) {
    for (const foreground of foregrounds) {
      it(`${foreground} on ${surface} meets WCAG AA`, () => {
        expect(
          contrast(token(`color-${foreground}`), token(`color-${surface}`)),
        ).toBeGreaterThanOrEqual(AA_TEXT);
      });
    }
  }

  it('text on action buttons meets WCAG AA', () => {
    expect(contrast(token('color-on-action'), token('color-action'))).toBeGreaterThanOrEqual(
      AA_TEXT,
    );
  });
});
