import type { TrackedHand } from './gestures.ts';

export type HandWorkerRequest =
  | { readonly type: 'initialize' }
  | { readonly type: 'frame'; readonly bitmap: ImageBitmap; readonly timestamp: number }
  | { readonly type: 'close' };
export type HandWorkerReply =
  | { readonly type: 'ready' }
  | {
      readonly type: 'result';
      readonly hands: readonly TrackedHand[];
      readonly inferenceMs: number;
    }
  | { readonly type: 'error'; readonly message: string };
