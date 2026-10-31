import { useEffect, useRef, useState, type Dispatch } from 'react';
import type { ShellPart } from '@ripple/contracts';
import { CameraSession, type CameraStatus } from './camera.ts';
import type { EditorAction } from './editor.ts';
import type { EditorPoint } from './shellGeometry.ts';
import {
  initialGestureState,
  interpretHands,
  type GestureSettings,
  type GestureStatus,
  type TrackedHand,
} from './gestures.ts';
import styles from './Studio.module.css';

// MediaPipe hand landmark topology: wrist, then thumb, index, middle, ring and little fingers.
const bones: readonly (readonly [number, number])[] = [
  [0, 1],
  [1, 2],
  [2, 3],
  [3, 4],
  [0, 5],
  [5, 6],
  [6, 7],
  [7, 8],
  [5, 9],
  [9, 10],
  [10, 11],
  [11, 12],
  [9, 13],
  [13, 14],
  [14, 15],
  [15, 16],
  [13, 17],
  [0, 17],
  [17, 18],
  [18, 19],
  [19, 20],
];

/** Draws tracked hands over the mirrored preview; pinching tips glow in the action colour. */
function drawHands(
  canvas: HTMLCanvasElement,
  hands: readonly TrackedHand[],
  status: GestureStatus,
) {
  const context = canvas.getContext('2d');
  if (context === null) return;
  const ratio = Math.min(window.devicePixelRatio || 1, 2),
    width = canvas.clientWidth,
    height = canvas.clientHeight;
  if (canvas.width !== Math.round(width * ratio)) canvas.width = Math.round(width * ratio);
  if (canvas.height !== Math.round(height * ratio)) canvas.height = Math.round(height * ratio);
  context.setTransform(ratio, 0, 0, ratio, 0, 0);
  context.clearRect(0, 0, width, height);
  const gripping = status === 'pinching' || status === 'scaling';
  for (const hand of hands) {
    const at = (index: number) => {
      const point = hand.landmarks[index];
      return point === undefined ? null : { x: (1 - point.x) * width, y: point.y * height };
    };
    context.lineWidth = 2.5;
    context.lineCap = 'round';
    context.strokeStyle = 'rgba(239, 232, 216, 0.85)';
    context.beginPath();
    for (const [from, to] of bones) {
      const a = at(from),
        b = at(to);
      if (a === null || b === null) continue;
      context.moveTo(a.x, a.y);
      context.lineTo(b.x, b.y);
    }
    context.stroke();
    for (let index = 0; index < hand.landmarks.length; index++) {
      const point = at(index);
      if (point === null) continue;
      const tip = index === 4 || index === 8;
      context.fillStyle = tip ? (gripping ? '#d4f25a' : '#ff7a57') : '#efe8d8';
      context.beginPath();
      context.arc(point.x, point.y, tip ? 6 : 3, 0, Math.PI * 2);
      context.fill();
    }
  }
}

const labels: Record<CameraStatus, string> = {
  idle: 'Camera off',
  requesting: 'Waiting for camera permission…',
  loading: 'Loading hand controls…',
  tracking: 'Camera on · show your hand',
};
export function HandControls({
  part,
  dispatch,
  available = true,
  onCamera,
  onPointer,
}: {
  part: ShellPart;
  dispatch: Dispatch<EditorAction>;
  /** False once a live studio closes: the camera stops and cannot restart for it. */
  available?: boolean;
  /** Reports camera use for anonymous studio metrics; it never affects a proposal. */
  onCamera?: (event: 'camera_enabled' | 'camera_failed') => void;
  /** The tracked fingertip in editor coordinates, for an on-stage cursor. Null when lost. */
  onPointer?: (point: EditorPoint | null, status: GestureStatus) => void;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const overlayRef = useRef<HTMLCanvasElement>(null);
  const session = useRef<CameraSession | null>(null);
  const latestPart = useRef(part);
  const gesture = useRef(initialGestureState);
  const activeGesture = useRef(false);
  const settingsRef = useRef<GestureSettings>({ oneHand: true, sensitivity: 1 });
  const [settings, setSettings] = useState<GestureSettings>({ oneHand: true, sensitivity: 1 });
  const [status, setStatus] = useState<CameraStatus>('idle');
  const [tracking, setTracking] = useState<GestureStatus>('tracking_lost');
  const [error, setError] = useState('');
  useEffect(() => {
    latestPart.current = part;
  }, [part]);
  useEffect(() => {
    settingsRef.current = settings;
  }, [settings]);
  useEffect(
    () => () => {
      session.current?.stop();
    },
    [],
  );
  useEffect(() => {
    if (available) return;
    session.current?.stop();
    session.current = null;
  }, [available]);
  function enable() {
    if (videoRef.current === null) return;
    setError('');
    session.current?.stop();
    const next = new CameraSession(videoRef.current, {
      onStatus: (next) => {
        setStatus(next);
        if (next === 'tracking') onCamera?.('camera_enabled');
        if (next === 'idle') {
          onPointer?.(null, 'tracking_lost');
          if (overlayRef.current !== null) drawHands(overlayRef.current, [], 'tracking_lost');
        }
      },
      onError: (message) => {
        setError(message);
        if (message !== '') onCamera?.('camera_failed');
      },
      onHands: (hands) => {
        const result = interpretHands(
          gesture.current,
          hands,
          latestPart.current.parameters,
          settingsRef.current,
        );
        gesture.current = result.state;
        setTracking(result.status);
        onPointer?.(result.state.point, result.status);
        if (overlayRef.current !== null) drawHands(overlayRef.current, hands, result.status);
        const active = result.status === 'pinching' || result.status === 'scaling';
        if (active && !activeGesture.current) dispatch({ type: 'begin' });
        for (const change of result.changes) dispatch(change);
        if (!active && activeGesture.current) dispatch({ type: 'end' });
        activeGesture.current = active;
      },
    });
    session.current = next;
    void next.start();
  }
  return (
    <section className={styles.handPanel} aria-labelledby="hand-title">
      <p className={styles.eyebrow}>01 / Your hands</p>
      <h2 id="hand-title">Your hands, your shell.</h2>
      <p className={styles.muted}>
        Optional camera controls. Video stays in this browser. No microphone is used. Pointer
        controls offer the same choices.
      </p>
      <div className={styles.cameraFrame} hidden={status === 'idle'} data-tracking={tracking}>
        <video
          ref={videoRef}
          muted
          playsInline
          className={styles.cameraPreview}
          aria-label="Mirrored camera preview"
        />
        <canvas ref={overlayRef} className={styles.cameraOverlay} aria-hidden="true" />
      </div>
      <p role="status" data-testid="camera-status">
        {error || labels[status]}
      </p>
      {status === 'tracking' && (
        <p data-testid="hand-status" className={styles.muted}>
          {tracking === 'tracking_lost'
            ? 'No hand detected · editing is frozen until tracking returns.'
            : tracking === 'pinching'
              ? 'Point grabbed · move your hand, then release.'
              : tracking === 'scaling'
                ? 'Two hands detected · move apart to scale.'
                : 'Hand detected · pinch a white control point to grab it.'}
        </p>
      )}
      {!available && <p>This studio has closed, so the camera is off. Your draft is kept.</p>}
      {status === 'idle' ? (
        <button onClick={enable} disabled={!available}>
          Enable hand controls
        </button>
      ) : (
        <button
          onClick={() => {
            session.current?.stop();
          }}
        >
          Turn camera off
        </button>
      )}
      <details>
        <summary>Calibration and hand controls</summary>
        <p className={styles.muted}>
          Face your palm toward the camera in good light. The preview is mirrored. Pinch thumb and
          index finger over a white point, move, and release. Tracking loss never saves or submits.
          With two-hand mode, pinch with both hands and move them apart to scale.
        </p>
        <label>
          <input
            type="checkbox"
            checked={settings.oneHand}
            onChange={(event) => {
              setSettings({ ...settings, oneHand: event.target.checked });
            }}
          />{' '}
          One-hand mode
        </label>
        <label className={styles.rangeLabel}>
          <span>
            Sensitivity<output>{settings.sensitivity.toFixed(1)}</output>
          </span>
          <input
            type="range"
            aria-label="Hand sensitivity"
            min="0.5"
            max="1.5"
            step="0.1"
            value={settings.sensitivity}
            onChange={(event) => {
              setSettings({ ...settings, sensitivity: Number(event.target.value) });
            }}
          />
        </label>
      </details>
    </section>
  );
}
