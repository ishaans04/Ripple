import {
  memo,
  useRef,
  type Dispatch,
  type KeyboardEvent,
  type PointerEvent,
  type RefObject,
} from 'react';
import { shellBounds, type ShellPart } from '@ripple/contracts';
import { ShellRenderer } from './ShellRenderer.tsx';
import { pointToParameter, shellGeometry, type ShellParameter } from './shellGeometry.ts';
import type { EditorAction } from './editor.ts';
import styles from './Studio.module.css';

export const EditorCanvas = memo(function EditorCanvas({
  part,
  dispatch,
  cursorRef,
}: {
  part: ShellPart;
  dispatch: Dispatch<EditorAction>;
  /** A hand-tracking cursor positioned directly by its owner, outside React rendering. */
  cursorRef?: RefObject<SVGGElement | null>;
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
      <ShellRenderer part={part} interactive label="Shell editor">
        {(Object.keys(handles) as ShellParameter[]).map((key) => (
          <g
            key={key}
            className={styles.handle}
            data-handle={key}
            role="slider"
            tabIndex={0}
            aria-label={`Shell ${key} control`}
            aria-valuemin={shellBounds[key].min}
            aria-valuemax={shellBounds[key].max}
            aria-valuenow={part.parameters[key]}
            onKeyDown={(event) => {
              keyboard(key, event);
            }}
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
            <circle cx={handles[key].x} cy={handles[key].y} r="44" className={styles.handleHalo} />
            <circle cx={handles[key].x} cy={handles[key].y} r="26" />
            <circle cx={handles[key].x} cy={handles[key].y} r="7" className={styles.handleDot} />
          </g>
        ))}
        {cursorRef !== undefined && (
          <g ref={cursorRef} className={styles.handCursor} data-status="lost" aria-hidden="true">
            <circle r="46" className={styles.handCursorRing} />
            <circle r="9" className={styles.handCursorDot} />
          </g>
        )}
      </ShellRenderer>
    </div>
  );
});
