import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import {
  APPEARANCE_MAPPING_VERSION,
  ancestryMarks,
  geneAppearance,
  markGlyph,
  markGlyphShapes,
  markGlyphTones,
} from './appearance.ts';

const legalGenome = fc
  .tuple(
    fc.integer({ min: 0, max: 15 }),
    fc.integer({ min: 0, max: 15 }),
    fc.integer({ min: 0, max: 15 }),
  )
  .filter(([pulse, calm, grit]) => pulse + calm + grit >= 9 && pulse + calm + grit <= 24)
  .map(([pulse, calm, grit]) => ({ pulse, calm, grit, drift: 24 - pulse - calm - grit }));
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const host = (n: number) => ({ channelId: id(n), label: `Channel ${n}` });

describe('versioned gene-linked appearance', () => {
  it('maps every legal genome to exactly one authored variant per part', () => {
    fc.assert(
      fc.property(legalGenome, (genome) => {
        const parts = geneAppearance(genome, APPEARANCE_MAPPING_VERSION);
        expect(['settled', 'sway', 'quick']).toContain(parts.movement);
        expect(['smooth', 'ridged', 'armored']).toContain(parts.plating);
        expect(['stubs', 'fins', 'streamers']).toContain(parts.appendages);
        expect(geneAppearance({ ...genome }, 1)).toEqual(parts);
      }),
    );
  });
  it('uses the documented version-one thresholds', () => {
    expect(geneAppearance({ pulse: 6, calm: 6, grit: 6, drift: 6 }, 1)).toEqual({
      movement: 'sway',
      plating: 'ridged',
      appendages: 'fins',
    });
    expect(geneAppearance({ pulse: 10, calm: 6, grit: 4, drift: 4 }, 1)).toEqual({
      movement: 'quick',
      plating: 'smooth',
      appendages: 'stubs',
    });
    expect(geneAppearance({ pulse: 2, calm: 6, grit: 6, drift: 10 }, 1)).toEqual({
      movement: 'settled',
      plating: 'ridged',
      appendages: 'streamers',
    });
    expect(geneAppearance({ pulse: 3, calm: 6, grit: 10, drift: 5 }, 1)).toEqual({
      movement: 'sway',
      plating: 'armored',
      appendages: 'fins',
    });
  });
  it('rejects unknown mapping versions and illegal genomes instead of guessing', () => {
    expect(() => geneAppearance({ pulse: 6, calm: 6, grit: 6, drift: 6 }, 2 as 1)).toThrow();
    expect(() => geneAppearance({ pulse: 7, calm: 6, grit: 6, drift: 6 }, 1)).toThrow();
  });
});

describe('ancestry marks', () => {
  it('keeps the origin and at most two ancestry hosts: the first divergence and the latest', () => {
    expect(ancestryMarks(host(0), [])).toEqual({ origin: host(0), ancestry: [] });
    expect(ancestryMarks(host(0), [host(0), host(1)])).toEqual({
      origin: host(0),
      ancestry: [host(1)],
    });
    expect(ancestryMarks(host(0), [host(1), host(0), host(2), host(3), host(4)])).toEqual({
      origin: host(0),
      ancestry: [host(1), host(4)],
    });
  });
  it('is bounded, excludes the origin, never duplicates and stays stable as hosts are appended', () => {
    fc.assert(
      fc.property(fc.array(fc.integer({ min: 0, max: 9 }), { maxLength: 40 }), (sequence) => {
        const hosts = [...new Set(sequence)].map(host),
          marks = ancestryMarks(host(0), hosts);
        expect(marks.ancestry.length).toBeLessThanOrEqual(2);
        expect(marks.ancestry.map((mark) => mark.channelId)).not.toContain(id(0));
        expect(new Set(marks.ancestry.map((mark) => mark.channelId)).size).toBe(
          marks.ancestry.length,
        );
        const visited = hosts.filter((item) => item.channelId !== id(0));
        if (visited.length > 0) expect(marks.ancestry[0]).toEqual(visited[0]);
        if (visited.length > 1) expect(marks.ancestry.at(-1)).toEqual(visited.at(-1));
      }),
    );
  });
  it('rejects duplicate host entries rather than silently reordering history', () => {
    expect(() => ancestryMarks(host(0), [host(1), host(1)])).toThrow();
  });
});

describe('mark glyphs', () => {
  it('derives one deterministic authored glyph from a channel identity, ignoring UUID case', () => {
    fc.assert(
      fc.property(fc.uuid(), (channelId) => {
        const glyph = markGlyph(channelId);
        expect(markGlyphShapes).toContain(glyph.shape);
        expect(markGlyphTones).toContain(glyph.tone);
        expect(markGlyph(channelId.toUpperCase())).toEqual(glyph);
      }),
    );
  });
  it('spreads distinct channels across every shape and tone', () => {
    const glyphs = Array.from({ length: 200 }, (_, n) => markGlyph(id(n)));
    expect(new Set(glyphs.map((glyph) => glyph.shape)).size).toBe(markGlyphShapes.length);
    expect(new Set(glyphs.map((glyph) => glyph.tone)).size).toBe(markGlyphTones.length);
  });
});
