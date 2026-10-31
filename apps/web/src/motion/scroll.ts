import { useEffect, useRef, type RefObject } from 'react';

export const clamp = (value: number, min = 0, max = 1): number =>
  Math.min(max, Math.max(min, value));

/**
 * Progress of an element through the viewport, from 0 to 1.
 * - `pass`: 0 when its top enters the bottom edge, 1 when its bottom leaves the top edge.
 * - `pin`: 0 when its top reaches the top edge, 1 when its bottom reaches the bottom edge;
 *   used by tall sections whose sticky child stays on screen while they scroll past.
 */
export function sectionProgress(
  rect: { top: number; height: number },
  viewport: number,
  mode: 'pass' | 'pin',
): number {
  if (mode === 'pin') {
    const travel = rect.height - viewport;
    return travel <= 0 ? (rect.top <= 0 ? 1 : 0) : clamp(-rect.top / travel);
  }
  return clamp((viewport - rect.top) / (rect.height + viewport));
}

type Listener = (scrollY: number, viewport: number) => void;
const listeners = new Set<Listener>();
let frame: number | null = null;

function flush() {
  frame = null;
  const scrollY = window.scrollY,
    viewport = window.innerHeight;
  for (const listener of listeners) listener(scrollY, viewport);
}
function schedule() {
  frame ??= requestAnimationFrame(flush);
}

/** One passive scroll/resize listener and at most one animation frame for every subscriber. */
export function onScrollFrame(listener: Listener): () => void {
  if (listeners.size === 0) {
    window.addEventListener('scroll', schedule, { passive: true });
    window.addEventListener('resize', schedule, { passive: true });
  }
  listeners.add(listener);
  schedule();
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) {
      window.removeEventListener('scroll', schedule);
      window.removeEventListener('resize', schedule);
      if (frame !== null) cancelAnimationFrame(frame);
      frame = null;
    }
  };
}

/**
 * Writes the element's scroll progress to `--progress` without a React render. An optional
 * callback receives each changed value, for effects that CSS cannot express.
 */
export function useScrollProgress<T extends HTMLElement>(
  mode: 'pass' | 'pin',
  onProgress?: (progress: number) => void,
): RefObject<T | null> {
  const ref = useRef<T>(null);
  const callback = useRef(onProgress);
  useEffect(() => {
    callback.current = onProgress;
  }, [onProgress]);
  useEffect(() => {
    const element = ref.current;
    if (element === null) return;
    let last = -1;
    return onScrollFrame((_scrollY, viewport) => {
      const progress = sectionProgress(element.getBoundingClientRect(), viewport, mode);
      if (Math.abs(progress - last) < 0.0005) return;
      last = progress;
      element.style.setProperty('--progress', progress.toFixed(4));
      callback.current?.(progress);
    });
  }, [mode]);
  return ref;
}

/**
 * Marks every `[data-reveal]` descendant visible once its box first comes within the lower
 * part of the viewport. Layout boxes are read on the shared scroll frame rather than with an
 * IntersectionObserver, because an observer counts the reveal's own clip-path and would never
 * see a fully clipped element.
 */
export function useReveal<T extends HTMLElement>(): RefObject<T | null> {
  const ref = useRef<T>(null);
  useEffect(() => {
    const root = ref.current;
    if (root === null) return;
    let pending = Array.from(root.querySelectorAll<HTMLElement>('[data-reveal]'));
    const stop = onScrollFrame((_scrollY, viewport) => {
      pending = pending.filter((target) => {
        const box = target.getBoundingClientRect();
        if (box.top > viewport * 0.92) return true;
        target.dataset.visible = '';
        return false;
      });
      if (pending.length === 0) queueMicrotask(stop);
    });
    return stop;
  }, []);
  return ref;
}

export function prefersReducedMotion(): boolean {
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}
