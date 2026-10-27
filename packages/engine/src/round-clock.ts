import { roundTimingsSchema, type RoundTimings } from '@ripple/contracts';
import { EngineError } from './errors.ts';

export type ActiveRoundPhase = 'VOTING' | 'OBSERVING' | 'REVEAL';
export interface RoundClock {
  readonly phase: ActiveRoundPhase | 'INTERRUPTED' | 'COMPLETE';
  readonly interruptedPhase: ActiveRoundPhase | null;
  readonly paused: boolean;
  readonly revision: number;
  readonly deadlineAtMs: number | null;
  readonly remainingMs: number;
  readonly elapsedMs: number;
  readonly segmentStartedAtMs: number;
  readonly observationEpoch: number;
}

function time(atMs: number): void {
  if (!Number.isSafeInteger(atMs) || atMs < 0)
    throw new EngineError('INVALID_ARGUMENT', 'Clock time must be a nonnegative safe integer.');
}
export function phaseDuration(phase: ActiveRoundPhase, timings: RoundTimings): number {
  switch (phase) {
    case 'VOTING':
      return timings.voteMs + timings.graceMs;
    case 'OBSERVING':
      return timings.observationMs;
    case 'REVEAL':
      return timings.revealMs;
  }
}
export function openRoundClock(atMs: number, timings: RoundTimings): RoundClock {
  time(atMs);
  roundTimingsSchema.parse(timings);
  const remainingMs = phaseDuration('VOTING', timings);
  return {
    phase: 'VOTING',
    interruptedPhase: null,
    paused: false,
    revision: 0,
    deadlineAtMs: atMs + remainingMs,
    remainingMs,
    elapsedMs: 0,
    segmentStartedAtMs: atMs,
    observationEpoch: 0,
  };
}
export function activeElapsed(clock: RoundClock, atMs: number): number {
  time(atMs);
  if (clock.paused || clock.deadlineAtMs === null) return clock.elapsedMs;
  return (
    clock.elapsedMs + Math.max(0, Math.min(atMs, clock.deadlineAtMs) - clock.segmentStartedAtMs)
  );
}
export function pauseRoundClock(clock: RoundClock, atMs: number): RoundClock {
  time(atMs);
  if (clock.paused || clock.phase === 'COMPLETE' || clock.phase === 'INTERRUPTED') return clock;
  return {
    ...clock,
    paused: true,
    revision: clock.revision + 1,
    deadlineAtMs: null,
    remainingMs: Math.max(0, (clock.deadlineAtMs ?? atMs) - atMs),
    elapsedMs: activeElapsed(clock, atMs),
  };
}
export function resumeRoundClock(clock: RoundClock, atMs: number): RoundClock {
  time(atMs);
  if (!clock.paused || clock.phase === 'INTERRUPTED' || clock.phase === 'COMPLETE') return clock;
  return {
    ...clock,
    paused: false,
    revision: clock.revision + 1,
    deadlineAtMs: atMs + clock.remainingMs,
    segmentStartedAtMs: atMs,
  };
}
/** A stale marker cannot close a resumed or already closed phase. */
export function advanceRoundClock(
  clock: RoundClock,
  revision: number,
  atMs: number,
  timings: RoundTimings,
): RoundClock {
  time(atMs);
  if (
    clock.revision !== revision ||
    clock.paused ||
    clock.deadlineAtMs === null ||
    atMs < clock.deadlineAtMs
  )
    return clock;
  let next: RoundClock['phase'];
  switch (clock.phase) {
    case 'VOTING':
      next = 'OBSERVING';
      break;
    case 'OBSERVING':
      next = 'REVEAL';
      break;
    case 'REVEAL':
      next = 'COMPLETE';
      break;
    case 'COMPLETE':
    case 'INTERRUPTED':
      return clock;
  }
  const remainingMs = next === 'COMPLETE' ? 0 : phaseDuration(next, timings);
  return {
    ...clock,
    phase: next,
    revision: clock.revision + 1,
    remainingMs,
    elapsedMs: 0,
    segmentStartedAtMs: atMs,
    deadlineAtMs: next === 'COMPLETE' ? null : atMs + remainingMs,
  };
}
/** Integration gaps discard the uncertain observation, never committed genes. */
export function interruptRoundClock(
  clock: RoundClock,
  atMs: number,
  timings: RoundTimings,
): RoundClock {
  time(atMs);
  if (clock.phase === 'INTERRUPTED' || clock.phase === 'COMPLETE') return clock;
  const checkpoint = pauseRoundClock(clock, atMs);
  return {
    ...checkpoint,
    phase: 'INTERRUPTED',
    interruptedPhase: clock.phase,
    paused: true,
    revision: clock.revision + 1,
    elapsedMs: clock.phase === 'OBSERVING' ? 0 : checkpoint.elapsedMs,
    remainingMs: clock.phase === 'OBSERVING' ? timings.observationMs : checkpoint.remainingMs,
  };
}
export function recoverRoundClock(clock: RoundClock, atMs: number): RoundClock {
  time(atMs);
  if (clock.phase !== 'INTERRUPTED' || clock.interruptedPhase === null) return clock;
  return {
    ...clock,
    phase: clock.interruptedPhase,
    interruptedPhase: null,
    paused: false,
    revision: clock.revision + 1,
    deadlineAtMs: atMs + clock.remainingMs,
    segmentStartedAtMs: atMs,
    observationEpoch: clock.observationEpoch + (clock.interruptedPhase === 'OBSERVING' ? 1 : 0),
  };
}
