import { useRef, type Dispatch, type PointerEvent, type KeyboardEvent } from 'react';
import { shellBounds, type ShellPart } from '@ripple/contracts';
import { ShellRenderer } from './ShellRenderer.tsx';
import { pointToParameter, shellGeometry, type ShellParameter } from './shellGeometry.ts';
import type { EditorAction } from './editor.ts';
import styles from './Studio.module.css';

export function EditorCanvas({
  part,
  dispatch,
}: {
  part: ShellPart;
  dispatch: Dispatch<EditorAction>;
}) {
  const active = useRef<ShellParameter | null>(null);
  const { handles } = shellGeometry(part.parameters);
  function move(event: PointerEvent<SVGGElement>) {
    const svg = event.currentTarget.ownerSVGElement;
    const matrix = svg?.getScreenCTM();
    if (active.current === null || matrix === null || matrix === undefined) return;
    const point = new DOMPoint(event.clientX, event.clientY).matrixTransform(matrix.inverse());
    dispatch({
      type: 'parameter',
      key: active.current,
      value: pointToParameter(active.current, point, part.parameters),
    });
  }
  function keyboard(key: ShellParameter, event: KeyboardEvent<SVGGElement>) {
    const step = event.shiftKey ? 1 : 10;
    const delta = ['ArrowUp', 'ArrowRight'].includes(event.key)
      ? step
      : ['ArrowDown', 'ArrowLeft'].includes(event.key)
        ? -step
        : 0;
    if (delta !== 0 || event.key === 'Home' || event.key === 'End') {
      event.preventDefault();
      dispatch({
        type: 'parameter',
        key,
        value:
          event.key === 'Home'
            ? shellBounds[key].min
            : event.key === 'End'
              ? shellBounds[key].max
              : part.parameters[key] + delta,
      });
    }
  }
  return (
    <div className={styles.canvas} data-testid="editor-canvas">
      <ShellRenderer part={part}>
        {(Object.keys(handles) as ShellParameter[]).map((key) => (
          <g
            key={key}
            className={styles.handle}
            role="slider"
            tabIndex={0}
            aria-label={`Shell ${key} control`}
            aria-valuemin={shellBounds[key].min}
            aria-valuemax={shellBounds[key].max}
            aria-valuenow={part.parameters[key]}
            onKeyDown={(event) => { keyboard(key, event); }}
            onPointerDown={(event) => {
              event.preventDefault();
              active.current = key;
              event.currentTarget.setPointerCapture(event.pointerId);
              dispatch({ type: 'begin' });
            }}
            onPointerMove={move}
            onPointerUp={(event) => {
              move(event);
              active.current = null;
              dispatch({ type: 'end' });
              event.currentTarget.releasePointerCapture(event.pointerId);
            }}
            onPointerCancel={() => {
              active.current = null;
              dispatch({ type: 'end' });
            }}
          >
            <circle cx={handles[key].x} cy={handles[key].y} r="26" />
            <circle cx={handles[key].x} cy={handles[key].y} r="7" className={styles.handleDot} />
          </g>
        ))}
      </ShellRenderer>
    </div>
  );
}
