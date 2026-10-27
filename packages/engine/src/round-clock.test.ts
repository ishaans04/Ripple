import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { liveRoundTimings } from '@ripple/contracts';
import {
  activeElapsed,
  advanceRoundClock,
  interruptRoundClock,
  openRoundClock,
  pauseRoundClock,
  recoverRoundClock,
  resumeRoundClock,
} from './round-clock.ts';

const timings = liveRoundTimings;
describe('active round clock', () => {
  it('consumes only active time across arbitrarily long offline gaps', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 45_999 }),
        fc.integer({ min: 1, max: 1_000_000_000 }),
        (elapsed, gap) => {
          const opened = openRoundClock(0, timings);
          const paused = pauseRoundClock(opened, elapsed);
          const resumed = resumeRoundClock(paused, elapsed + gap);
          expect(resumed.deadlineAtMs).toBe(46_000 + gap);
          expect(activeElapsed(resumed, elapsed + gap)).toBe(elapsed);
          expect(advanceRoundClock(resumed, opened.revision, 100_000 + gap, timings)).toBe(resumed);
        },
      ),
    );
  });
  it('advances exactly once at each durable cutoff', () => {
    const opened = openRoundClock(0, timings);
    expect(advanceRoundClock(opened, 0, 45_999, timings)).toBe(opened);
    const observing = advanceRoundClock(opened, 0, 46_000, timings);
    expect(observing.phase).toBe('OBSERVING');
    expect(advanceRoundClock(observing, 0, 46_000, timings)).toBe(observing);
    const reveal = advanceRoundClock(observing, 1, 166_000, timings);
    expect(reveal.phase).toBe('REVEAL');
    expect(advanceRoundClock(reveal, 2, 180_000, timings).phase).toBe('COMPLETE');
  });
  it('reopens a complete observation after a missing interval with a new epoch', () => {
    const observing = advanceRoundClock(openRoundClock(0, timings), 0, 46_000, timings);
    const interrupted = interruptRoundClock(observing, 100_000, timings);
    expect(interrupted).toMatchObject({ phase: 'INTERRUPTED', elapsedMs: 0, remainingMs: 120_000 });
    const recovered = recoverRoundClock(interrupted, 1_000_000);
    expect(recovered).toMatchObject({
      phase: 'OBSERVING',
      observationEpoch: 1,
      deadlineAtMs: 1_120_000,
    });
    expect(interruptRoundClock(interrupted, 200_000, timings)).toBe(interrupted);
  });
});
