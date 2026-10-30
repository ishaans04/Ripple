import { describe, expect, it } from 'vitest';
import { familyRemainingText, familyUpdateText } from './family-text.ts';

const base = {
  lineageId: '00000000-0000-4000-8000-000000000001',
  sequence: 4,
  organismId: '00000000-0000-4000-8000-000000000002',
  organismName: '<Tide>',
  generation: 2,
  host: { channelId: '00000000-0000-4000-8000-000000000003', label: 'Mira' },
  traceTemplate: null,
};

describe('family update text', () => {
  it('describes each structural update in one sentence', () => {
    expect(familyUpdateText({ ...base, kind: 'fossilized' })).toBe(
      '<Tide> (generation 2) became a fossil at Mira',
    );
    expect(familyUpdateText({ ...base, kind: 'admitted' })).toBe(
      '<Tide> (generation 2) was admitted at Mira',
    );
    expect(familyUpdateText({ ...base, kind: 'born' })).toBe(
      '<Tide> (generation 2) was born from a raid by Mira',
    );
    expect(familyUpdateText({ ...base, kind: 'trace_earned', traceTemplate: 'shelter' })).toBe(
      '<Tide> (generation 2) earned a Shelter trace at Mira',
    );
    expect(familyUpdateText({ ...base, kind: 'archived', host: null })).toBe(
      '<Tide> (generation 2) ended before admission',
    );
  });
  it('points to the lineage map only when more updates exist', () => {
    expect(familyRemainingText({ items: [], remaining: 0 })).toBeNull();
    expect(familyRemainingText({ items: [], remaining: 1 })).toBe(
      '1 more family update in the lineage map',
    );
    expect(familyRemainingText({ items: [], remaining: 4 })).toBe(
      '4 more family updates in the lineage map',
    );
  });
});
