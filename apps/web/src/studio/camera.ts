import type { TrackedHand } from './gestures.ts';
import type { HandWorkerReply, HandWorkerRequest } from './handProtocol.ts';

export type CameraStatus = 'idle' | 'requesting' | 'loading' | 'tracking';
export interface CameraCallbacks {
  onStatus(status: CameraStatus): void;
  onHands(hands: readonly TrackedHand[]): void;
  onError(message: string): void;
}

/** One owned stream, worker, and in-flight frame; asynchronous acquisition is cancellable. */
export class CameraSession {
  private readonly video: HTMLVideoElement;
  private readonly callbacks: CameraCallbacks;
  private stream: MediaStream | null = null;
  private worker: Worker | null = null;
  private generation = 0;
  private frameId: number | null = null;
  private watchdog: ReturnType<typeof setTimeout> | null = null;
  private busy = false;
  private ready = false;
  private nextFrame = 0;
  private interval = 100;
  private readonly visibility = () => {
    if (document.hidden) {
      if (this.frameId !== null) cancelAnimationFrame(this.frameId);
      this.frameId = null;
      this.callbacks.onHands([]);
    } else if (this.ready && this.frameId === null) this.schedule();
  };
  private readonly exit = () => {
    this.stop();
  };

  constructor(video: HTMLVideoElement, callbacks: CameraCallbacks) {
    this.video = video;
    this.callbacks = callbacks;
  }

  async start(): Promise<void> {
    this.stop();
    const generation = this.generation;
    this.callbacks.onStatus('requesting');
    try {
      const mediaDevices = (navigator as Partial<Navigator>).mediaDevices;
      if (!window.isSecureContext || mediaDevices === undefined) {
        throw new Error('Camera support requires HTTPS or localhost.');
      }
      const stream = await mediaDevices.getUserMedia({
        video: { width: { ideal: 640 }, height: { ideal: 480 }, frameRate: { ideal: 15, max: 30 } },
        audio: false,
      });
      if (generation !== this.generation) {
        stream.getTracks().forEach((track) => {
          track.stop();
        });
        return;
      }
      this.stream = stream;
      this.video.srcObject = stream;
      await this.video.play();
      if (generation !== this.generation) return;
      this.callbacks.onStatus('loading');
      const worker = new Worker(new URL('./hand-worker.ts', import.meta.url), {
        type: 'module',
        name: 'ripple-hand-tracking',
      });
      this.worker = worker;
      worker.onerror = () => {
        if (generation === this.generation)
          this.fail(
            'The tracking worker could not start. Your draft is kept; pointer controls are ready.',
          );
      };
      worker.onmessage = (event: MessageEvent<HandWorkerReply>) => {
        if (generation !== this.generation) return;
        this.clearWatchdog();
        const reply = event.data;
        if (reply.type === 'error') {
          this.fail(reply.message);
          return;
        }
        if (reply.type === 'ready') {
          this.ready = true;
          this.callbacks.onStatus('tracking');
          this.schedule();
        } else {
          this.busy = false;
          this.interval = Math.min(400, Math.max(75, reply.inferenceMs * 1.5));
          if (!document.hidden) this.callbacks.onHands(reply.hands);
        }
      };
      document.addEventListener('visibilitychange', this.visibility);
      window.addEventListener('pagehide', this.exit);
      this.watchdog = setTimeout(() => {
        this.fail(
          'The hand model took too long to load. Your draft is kept; try pointer controls.',
        );
      }, 30000);
      this.send({ type: 'initialize' });
    } catch (error) {
      if (generation !== this.generation) return;
      const denied = error instanceof DOMException && error.name === 'NotAllowedError';
      this.fail(
        denied
          ? 'Camera permission was denied. You can keep shaping with pointer controls.'
          : 'The camera is unavailable. Check browser camera support and HTTPS, or keep using pointer controls.',
      );
    }
  }

  private clearWatchdog(): void {
    if (this.watchdog !== null) clearTimeout(this.watchdog);
    this.watchdog = null;
  }
  private fail(message: string): void {
    this.stop();
    this.callbacks.onError(message);
  }
  private send(message: HandWorkerRequest): void {
    this.worker?.postMessage(message);
  }
  private schedule(): void {
    if (!this.ready || document.hidden || this.frameId !== null) return;
    this.frameId = requestAnimationFrame((time) => {
      this.frameId = null;
      this.frame(time);
    });
  }
  private frame(time: number): void {
    this.schedule();
    if (this.busy || time < this.nextFrame || this.video.readyState < 2) return;
    this.busy = true;
    this.nextFrame = time + this.interval;
    const generation = this.generation;
    void createImageBitmap(this.video).then(
      (bitmap) => {
        if (generation !== this.generation || this.worker === null || document.hidden) {
          bitmap.close();
          if (generation === this.generation) this.busy = false;
          return;
        }
        this.watchdog = setTimeout(() => {
          this.fail(
            'Hand tracking stopped responding. Your draft is kept; pointer controls are ready.',
          );
        }, 5000);
        this.worker.postMessage(
          { type: 'frame', bitmap, timestamp: performance.now() } satisfies HandWorkerRequest,
          [bitmap],
        );
      },
      () => {
        if (generation === this.generation)
          this.fail('The camera frame could not be read. Your draft is kept.');
      },
    );
  }
  stop(): void {
    this.generation += 1;
    this.ready = false;
    this.busy = false;
    this.clearWatchdog();
    if (this.frameId !== null) cancelAnimationFrame(this.frameId);
    this.frameId = null;
    this.worker?.terminate();
    this.worker = null;
    this.stream?.getTracks().forEach((track) => {
      track.stop();
    });
    this.stream = null;
    this.video.pause();
    this.video.srcObject = null;
    document.removeEventListener('visibilitychange', this.visibility);
    window.removeEventListener('pagehide', this.exit);
    this.callbacks.onHands([]);
    this.callbacks.onStatus('idle');
  }
}
