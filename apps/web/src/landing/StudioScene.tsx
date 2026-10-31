import { useCallback, useState, type CSSProperties } from 'react';
import {
  founderShell,
  type ShellParameters,
  type ShellPart,
  type markingPatterns,
  type shellPalettes,
} from '@ripple/contracts';
import { ShellRenderer } from '../studio/ShellRenderer.tsx';
import { shellGeometry, type ShellParameter } from '../studio/shellGeometry.ts';
import { clamp, useScrollProgress } from '../motion/scroll.ts';
import styles from './Landing.module.css';

const gestures = [
  { title: 'Enable hand controls', detail: 'Video stays in your browser. No microphone is used.' },
  { title: 'Pinch a white point', detail: 'Thumb and index finger together over a control.' },
  { title: 'Pull to sculpt', detail: 'Move your hand. Width, height and crown follow it.' },
  {
    title: 'Release to set it',
    detail: 'Open your fingers. Pick a marking and palette to sign it.',
  },
] as const;

const ease = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);
const lerp = (from: number, to: number, t: number) => from + (to - from) * ease(clamp(t));
const snap = (value: number) => Math.round(value / 5) * 5;

/** Scroll progress choreographs one sculpting session within the shell bounds. */
function sculptAt(progress: number): {
  part: ShellPart;
  active: ShellParameter;
  step: number;
} {
  const segment = (from: number) => (progress - from) / 0.22;
  const parameters: ShellParameters = {
    width: snap(lerp(lerp(440, 800, segment(0.04)), 700, segment(0.78))),
    height: snap(lerp(lerp(300, 680, segment(0.28)), 560, segment(0.78))),
    curvature: snap(lerp(lerp(160, 720, segment(0.52)), 420, segment(0.78))),
  };
  const patternId: (typeof markingPatterns)[number] =
    progress < 0.55 ? 'plain' : progress < 0.8 ? 'bands' : 'dots';
  const paletteId: (typeof shellPalettes)[number] =
    progress < 0.4 ? 'teal-amber' : progress < 0.8 ? 'coral-ink' : 'moss-cream';
  return {
    part: { ...founderShell, parameters, marking: { patternId, paletteId } },
    active: progress < 0.28 ? 'width' : progress < 0.52 ? 'height' : 'curvature',
    step: Math.min(3, Math.floor(clamp(progress * 1.12) * 4)),
  };
}

export function StudioScene() {
  const [scene, setScene] = useState(() => sculptAt(0));
  const update = useCallback((progress: number) => {
    const next = sculptAt(progress);
    setScene((current) =>
      current.step === next.step &&
      current.active === next.active &&
      current.part.marking.patternId === next.part.marking.patternId &&
      current.part.marking.paletteId === next.part.marking.paletteId &&
      current.part.parameters.width === next.part.parameters.width &&
      current.part.parameters.height === next.part.parameters.height &&
      current.part.parameters.curvature === next.part.parameters.curvature
        ? current
        : next,
    );
  }, []);
  const ref = useScrollProgress<HTMLElement>('pin', update);
  const { handles } = shellGeometry(scene.part.parameters);
  const grip = handles[scene.active];
  const pinched = scene.step >= 1 && scene.step <= 2;
  return (
    <section ref={ref} id="studio" className={styles.studioSection} aria-labelledby="studio-title">
      <div className={styles.studioSticky}>
        <div className={styles.studioCopy}>
          <p className={styles.sectionTag}>
            <span>03</span> Cocoon Studio
          </p>
          <h2 id="studio-title" className={styles.sectionTitle}>
            Shape it with <em>your hands.</em>
          </h2>
          <ol className={styles.gestureList}>
            {gestures.map((gesture, index) => (
              <li
                key={gesture.title}
                data-state={
                  index < scene.step ? 'done' : index === scene.step ? 'active' : 'waiting'
                }
              >
                <span className={styles.gestureIndex}>{index + 1}</span>
                <span>
                  <strong>{gesture.title}</strong>
                  <span>{gesture.detail}</span>
                </span>
              </li>
            ))}
          </ol>
          <a href="/studio" className={styles.primary}>
            Open the practice studio <span aria-hidden="true">→</span>
          </a>
        </div>
        <div className={styles.studioStage} aria-hidden="true">
          <div className={styles.stageDish} />
          <div className={styles.stageShell}>
            <ShellRenderer part={scene.part} label="Studio preview">
              {(Object.keys(handles) as ShellParameter[]).map((key) => (
                <circle
                  key={key}
                  cx={handles[key].x}
                  cy={handles[key].y}
                  r={key === scene.active ? 22 : 16}
                  className={styles.stageHandle}
                  data-active={key === scene.active}
                />
              ))}
              <g
                className={styles.pinch}
                data-pinched={pinched}
                style={{ '--gx': `${grip.x}px`, '--gy': `${grip.y}px` } as CSSProperties}
              >
                <circle className={styles.pinchRing} r="70" />
                <circle className={styles.pinchThumb} r="19" />
                <circle className={styles.pinchIndex} r="19" />
              </g>
            </ShellRenderer>
          </div>
          <dl className={styles.readouts}>
            {(['width', 'height', 'curvature'] as const).map((key) => (
              <div key={key} data-active={key === scene.active}>
                <dt>{key}</dt>
                <dd>{scene.part.parameters[key]}</dd>
              </div>
            ))}
            <div>
              <dt>marking</dt>
              <dd>{scene.part.marking.patternId}</dd>
            </div>
          </dl>
        </div>
      </div>
    </section>
  );
}
