import { describe, expect, it } from 'vitest';
import { recordedSelection } from './passport-read.ts';

const before = { pulse: 6, calm: 6, grit: 6, drift: 6 },
  grit = { pulse: 4, calm: 6, grit: 8, drift: 6 },
  calm = { pulse: 6, calm: 8, grit: 6, drift: 4 },
  saved = {
    roundId: '00000000-0000-4000-8000-000000000001',
    number: 1,
    host: { channelId: '00000000-0000-4000-8000-000000000002', label: 'Home' },
    openedAt: '2026-10-30T00:00:00.000Z',
    genomeBefore: before,
    candidates: [
      {
        id: 'grit+2/pulse-2',
        genome: grit,
        effect: 'Reinforce shell',
        tradeOff: 'Less burst',
        source: 'generated' as const,
      },
      {
        id: 'calm+2/drift-2',
        genome: calm,
        effect: 'Settle',
        tradeOff: 'Smaller reserve',
        source: 'dormant' as const,
      },
    ],
    mutationSelection: null,
    participantGenome: null,
  };

describe('recorded passport selections', () => {
  it('uses the version-one recorded selection, including an explicit Hold', () => {
    expect(
      recordedSelection({ ...saved, mutationSelection: { choiceId: 'calm+2/drift-2' } }),
    ).toEqual({
      status: 'selected',
      effect: 'Settle',
      tradeOff: 'Smaller reserve',
      source: 'dormant',
      genomeAfter: calm,
    });
    expect(recordedSelection({ ...saved, mutationSelection: { choiceId: null } })).toEqual({
      status: 'hold',
    });
  });
  it('matches the participant genome captured at close for older rounds', () => {
    expect(recordedSelection({ ...saved, participantGenome: grit })).toMatchObject({
      status: 'selected',
      effect: 'Reinforce shell',
    });
    expect(recordedSelection({ ...saved, participantGenome: before })).toEqual({
      status: 'hold',
    });
  });
  it('reports rounds without recorded selections or participants as unrecorded', () => {
    expect(recordedSelection(saved)).toEqual({ status: 'unrecorded' });
  });
  it('fails loudly instead of guessing when records disagree', () => {
    expect(() =>
      recordedSelection({ ...saved, mutationSelection: { choiceId: 'drift+2/grit-2' } }),
    ).toThrow();
    expect(() =>
      recordedSelection({
        ...saved,
        participantGenome: { pulse: 8, calm: 4, grit: 6, drift: 6 },
      }),
    ).toThrow();
  });
});
