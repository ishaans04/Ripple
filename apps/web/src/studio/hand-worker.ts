/// <reference lib="webworker" />
import { FilesetResolver, HandLandmarker } from '@mediapipe/tasks-vision';
import type { HandWorkerRequest, HandWorkerReply } from './handProtocol.ts';

const scope = self as unknown as DedicatedWorkerGlobalScope;
let landmarker: HandLandmarker | null = null;
const respond = (reply: HandWorkerReply) => {
  scope.postMessage(reply);
};
scope.onmessage = async (event: MessageEvent<HandWorkerRequest>) => {
  const message = event.data;
  if (message.type === 'close') {
    landmarker?.close();
    landmarker = null;
    scope.close();
    return;
  }
  if (message.type === 'initialize') {
    try {
      const files = await FilesetResolver.forVisionTasks('/vision/mediapipe-1.1.1', true);
      landmarker = await HandLandmarker.createFromOptions(files, {
        baseOptions: { modelAssetPath: '/vision/hand_landmarker_v1.task', delegate: 'CPU' },
        runningMode: 'VIDEO',
        numHands: 2,
        minHandDetectionConfidence: 0.6,
        minHandPresenceConfidence: 0.6,
        minTrackingConfidence: 0.6,
      });
      respond({ type: 'ready' });
    } catch {
      respond({
        type: 'error',
        message: 'The hand model could not load in this browser. Pointer controls are ready.',
      });
    }
    return;
  }
  try {
    if (landmarker === null) throw new Error('Hand model not ready');
    const started = performance.now();
    const result = landmarker.detectForVideo(message.bitmap, message.timestamp);
    respond({
      type: 'result',
      inferenceMs: performance.now() - started,
      hands: result.landmarks.map((landmarks, index) => ({
        landmarks: landmarks.map(({ x, y }) => ({ x, y })),
        confidence: result.handedness[index]?.[0]?.score ?? 0,
      })),
    });
  } catch {
    respond({
      type: 'error',
      message:
        'Hand tracking stopped. Your draft is kept; use pointer controls or enable the camera again.',
    });
  } finally {
    message.bitmap.close();
  }
};
