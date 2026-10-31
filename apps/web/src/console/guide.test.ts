import { describe, expect, it } from 'vitest';
import type { ControllerStatus } from '@ripple/contracts';
import {
  controllerGuide,
  milestoneFor,
  nextStep,
  sandboxGuide,
  sequence,
  type SandboxMilestone,
} from './guide.ts';

const states = (steps: { id: string; state: string }[]) =>
  Object.fromEntries(steps.map((step) => [step.id, step.state]));

function status(overrides: Partial<ControllerStatus> = {}): ControllerStatus {
  return {
    worldId: '00000000-0000-4000-8000-000000000001',
    channelId: '00000000-0000-4000-8000-000000000002',
    csrfToken: 'csrf',
    authorized: true,
    botAuthorized: false,
    callbackReady: false,
    subscriptionsReady: false,
    subscriptions: [],
    settings: {
      input_error: null,
      visitor_policy: 'ask',
      last_seed_at: null,
      seed_cooldown_ms: 60000,
    },
    snapshot: null,
    readClients: 0,
    ...overrides,
  };
}

describe('guide sequencing', () => {
  it('makes the first unfinished required step next and keeps optional steps optional', () => {
    const steps = sequence([
      { id: 'a', target: 'x', title: 'A', detail: '', done: true },
      { id: 'b', target: 'x', title: 'B', detail: '', done: null },
      { id: 'c', target: 'x', title: 'C', detail: '', done: false },
      { id: 'd', target: 'x', title: 'D', detail: '', done: false },
    ]);
    expect(states(steps)).toEqual({ a: 'done', b: 'optional', c: 'next', d: 'todo' });
    expect(nextStep(steps)?.id).toBe('c');
  });

  it('locks every unfinished step when access is unavailable', () => {
    const steps = sequence(
      [
        { id: 'a', target: 'x', title: 'A', detail: '', done: false },
        { id: 'b', target: 'x', title: 'B', detail: '', done: null },
      ],
      true,
    );
    expect(states(steps)).toEqual({ a: 'locked', b: 'locked' });
    expect(nextStep(steps)).toBeNull();
  });
});

describe('controller guide', () => {
  it('asks a signed-out broadcaster to connect first', () => {
    const steps = controllerGuide(true, null);
    expect(nextStep(steps)?.id).toBe('connect');
    expect(states(steps).seed).toBe('todo');
  });

  it('locks the console when live Twitch is disabled', () => {
    const steps = controllerGuide(false, null);
    expect(nextStep(steps)).toBeNull();
    expect(new Set(steps.map((step) => step.state))).toEqual(new Set(['locked']));
  });

  it('follows real readiness from bot authorization to the overlay', () => {
    expect(nextStep(controllerGuide(true, status()))?.id).toBe('bot');
    expect(nextStep(controllerGuide(true, status({ botAuthorized: true })))?.id).toBe('events');
    const ready = { botAuthorized: true, callbackReady: true, subscriptionsReady: true };
    expect(nextStep(controllerGuide(true, status(ready)))?.id).toBe('seed');
    expect(nextStep(controllerGuide(true, status({ ...ready, readClients: 1 })))?.id).toBe('seed');
  });
});

describe('sandbox guide', () => {
  it('starts with creating a world and advances through recorded milestones', () => {
    expect(nextStep(sandboxGuide(false, new Set()))?.id).toBe('start');
    const done = new Set<SandboxMilestone>(['voted']);
    expect(nextStep(sandboxGuide(true, done))?.id).toBe('observe');
    done.add('observed').add('raided').add('proposed').add('approved').add('replayed');
    expect(nextStep(sandboxGuide(true, done))).toBeNull();
  });

  it('tells the visitor to close an open ballot before shaping the habitat', () => {
    const voted = new Set<SandboxMilestone>(['voted']);
    expect(nextStep(sandboxGuide(true, voted, 'VOTING'))?.detail).toMatch(/Next scheduled step/);
    expect(nextStep(sandboxGuide(true, voted, 'OBSERVING'))?.detail).toMatch(/add local chat/);
  });

  it('counts habitat input only while the round is observing', () => {
    expect(milestoneFor('chat', { round: null })).toBeNull();
    const observing = {
      round: {
        id: '00000000-0000-4000-8000-000000000003',
        number: 1,
        phase: 'OBSERVING',
        clock: { paused: false, remainingMs: 0, deadlineAtMs: null },
        candidates: [],
      },
    } as unknown as Parameters<typeof milestoneFor>[1];
    expect(milestoneFor('shock', observing)).toBe('observed');
    expect(milestoneFor('vote', null)).toBe('voted');
    expect(milestoneFor('next', null)).toBeNull();
  });
});
