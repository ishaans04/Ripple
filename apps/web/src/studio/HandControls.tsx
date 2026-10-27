import { useEffect, useRef, useState, type Dispatch } from 'react';
import type { ShellPart } from '@ripple/contracts';
import { CameraSession, type CameraStatus } from './camera.ts';
import type { EditorAction } from './editor.ts';
import {
  initialGestureState,
  interpretHands,
  type GestureSettings,
  type GestureStatus,
} from './gestures.ts';
import styles from './Studio.module.css';

const labels: Record<CameraStatus, string> = {
  idle: 'Camera off',
  requesting: 'Waiting for camera permission…',
  loading: 'Loading hand controls…',
  tracking: 'Camera on · show your hand',
};
export function HandControls({
  part,
  dispatch,
}: {
  part: ShellPart;
  dispatch: Dispatch<EditorAction>;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
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
  function enable() {
    if (videoRef.current === null) return;
    setError('');
    session.current?.stop();
    const next = new CameraSession(videoRef.current, {
      onStatus: setStatus,
      onError: setError,
      onHands: (hands) => {
        const result = interpretHands(
          gesture.current,
          hands,
          latestPart.current.parameters,
          settingsRef.current,
        );
        gesture.current = result.state;
        setTracking(result.status);
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
      <p className={styles.eyebrow}>Shape by hand</p>
      <h2 id="hand-title">Your hands, your shell.</h2>
      <p className={styles.muted}>
        Optional camera controls. Video stays in this browser. No microphone is used. Pointer
        controls offer the same choices.
      </p>
      <video
        ref={videoRef}
        muted
        playsInline
        className={styles.cameraPreview}
        aria-label="Mirrored camera preview"
        hidden={status === 'idle'}
      />
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
      {status === 'idle' ? (
        <button onClick={enable}>Enable hand controls</button>
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
