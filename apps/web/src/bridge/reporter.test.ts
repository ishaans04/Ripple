import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SceneReporter, type BridgeSignal } from './reporter.ts';

describe('OBS scene reporter', () => {
  let sent: BridgeSignal[];
  let reporter: SceneReporter;
  beforeEach(() => {
    vi.useFakeTimers();
    sent = [];
    reporter = new SceneReporter(
      (signal) => {
        sent.push(signal);
        return Promise.resolve(true);
      },
      {
        setTimeout: (callback, ms) => setTimeout(callback, ms) as unknown as number,
        clearTimeout: (id) => {
          clearTimeout(id);
        },
      },
    );
  });
  afterEach(() => {
    vi.useRealTimers();
  });
  it('reconciles the current scene immediately and debounces rapid switches', async () => {
    reporter.reconcile('Gameplay');
    reporter.sceneChanged('BRB');
    reporter.sceneChanged('Gameplay');
    reporter.sceneChanged('BRB');
    await vi.advanceTimersByTimeAsync(1499);
    expect(sent).toEqual([{ kind: 'scene', scene: 'Gameplay' }]);
    await vi.advanceTimersByTimeAsync(1);
    expect(sent).toEqual([
      { kind: 'scene', scene: 'Gameplay' },
      { kind: 'scene', scene: 'BRB' },
    ]);
  });
  it('does not repeat a reported scene but reconciles it again after reconnecting', async () => {
    reporter.reconcile('BRB');
    await vi.advanceTimersByTimeAsync(0);
    reporter.sceneChanged('BRB');
    await vi.advanceTimersByTimeAsync(2000);
    expect(sent).toHaveLength(1);
    reporter.reconcile('BRB');
    expect(sent).toHaveLength(2);
  });
  it('reports hiding as stale, cancels a pending switch and carries the scene in heartbeats', async () => {
    reporter.reconcile('Gameplay');
    reporter.sceneChanged('BRB');
    reporter.hidden();
    await vi.advanceTimersByTimeAsync(5000);
    expect(sent).toEqual([{ kind: 'scene', scene: 'Gameplay' }, { kind: 'hidden' }]);
    reporter.heartbeat();
    expect(sent.at(-1)).toEqual({ kind: 'heartbeat', scene: 'BRB' });
  });
});
