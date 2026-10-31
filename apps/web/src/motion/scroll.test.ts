import { describe, expect, it } from 'vitest';
import { clamp, sectionProgress } from './scroll.ts';

describe('section scroll progress', () => {
  it('passes from entering the bottom edge to leaving the top edge', () => {
    expect(sectionProgress({ top: 800, height: 400 }, 800, 'pass')).toBe(0);
    expect(sectionProgress({ top: 200, height: 400 }, 800, 'pass')).toBe(0.5);
    expect(sectionProgress({ top: -400, height: 400 }, 800, 'pass')).toBe(1);
  });

  it('pins from reaching the top edge until its bottom reaches the bottom edge', () => {
    expect(sectionProgress({ top: 120, height: 3200 }, 800, 'pin')).toBe(0);
    expect(sectionProgress({ top: -1200, height: 3200 }, 800, 'pin')).toBe(0.5);
    expect(sectionProgress({ top: -5000, height: 3200 }, 800, 'pin')).toBe(1);
  });

  it('treats a pinned section no taller than the viewport as a step', () => {
    expect(sectionProgress({ top: 10, height: 600 }, 800, 'pin')).toBe(0);
    expect(sectionProgress({ top: -1, height: 600 }, 800, 'pin')).toBe(1);
  });

  it('clamps to its bounds', () => {
    expect(clamp(-2)).toBe(0);
    expect(clamp(3)).toBe(1);
    expect(clamp(5, 0, 10)).toBe(5);
  });
});
