export type BridgeSignal =
  | { kind: 'scene'; scene: string }
  | { kind: 'heartbeat'; scene: string | null }
  | { kind: 'hidden' };

export interface ReporterTimers {
  setTimeout: (callback: () => void, ms: number) => number;
  clearTimeout: (id: number) => void;
}

/**
 * Turns OBS scene events into bridge signals: it reconciles the current scene on load and on
 * reconnect, debounces rapid switches, never repeats an already reported scene, and reports a
 * hidden source as stale rather than as a return.
 */
export class SceneReporter {
  private reported: string | null = null;
  private latest: string | null = null;
  private pending: number | null = null;
  private readonly send: (signal: BridgeSignal) => Promise<boolean>;
  private readonly timers: ReporterTimers;
  private readonly debounceMs: number;
  constructor(
    send: (signal: BridgeSignal) => Promise<boolean>,
    timers: ReporterTimers,
    debounceMs = 1500,
  ) {
    this.send = send;
    this.timers = timers;
    this.debounceMs = debounceMs;
  }
  /** Load and reconnect: report the current scene immediately, even if it was reported before. */
  reconcile(scene: string | null): void {
    this.latest = scene;
    this.cancel();
    if (scene !== null) this.flush(true);
  }
  sceneChanged(scene: string): void {
    this.latest = scene;
    this.cancel();
    this.pending = this.timers.setTimeout(() => {
      this.pending = null;
      this.flush(false);
    }, this.debounceMs);
  }
  heartbeat(): void {
    void this.send({ kind: 'heartbeat', scene: this.latest });
  }
  hidden(): void {
    this.cancel();
    // After hiding, the next visible reconcile must report again.
    this.reported = null;
    void this.send({ kind: 'hidden' });
  }
  private cancel(): void {
    if (this.pending !== null) this.timers.clearTimeout(this.pending);
    this.pending = null;
  }
  private flush(force: boolean): void {
    const scene = this.latest;
    if (scene === null || (!force && scene === this.reported)) return;
    void this.send({ kind: 'scene', scene }).then((accepted) => {
      if (accepted) this.reported = scene;
    });
  }
}
