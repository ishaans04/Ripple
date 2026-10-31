import { useEffect, useMemo, useRef, useState } from 'react';
import { onScrollFrame, prefersReducedMotion } from '../motion/scroll.ts';
import type { TourStop } from './guide.ts';
import styles from './Console.module.css';

/**
 * A guided walk through the rendered sections. The spotlight only dims the page and never
 * captures the pointer, so a viewer can act on the highlighted section while the tour runs.
 * Stops whose section is not on the page are skipped.
 */
export function Tour({ stops, onClose }: { stops: readonly TourStop[]; onClose: () => void }) {
  const available = useMemo(
    () => stops.filter((stop) => document.getElementById(stop.target) !== null),
    [stops],
  );
  const [index, setIndex] = useState(0);
  const spotlight = useRef<HTMLDivElement>(null);
  const card = useRef<HTMLDivElement>(null);
  const stop = available[index];
  const last = index === available.length - 1;

  useEffect(() => {
    card.current?.focus();
  }, []);
  useEffect(() => {
    if (stop === undefined) return;
    const target = document.getElementById(stop.target);
    if (target === null) return;
    target.scrollIntoView({
      block: target.offsetHeight > window.innerHeight * 0.7 ? 'start' : 'center',
      behavior: prefersReducedMotion() ? 'auto' : 'smooth',
    });
    return onScrollFrame(() => {
      const light = spotlight.current;
      if (light === null) return;
      const box = target.getBoundingClientRect(),
        pad = 10;
      light.style.transform = `translate3d(${box.left - pad}px, ${box.top - pad}px, 0)`;
      light.style.width = `${box.width + pad * 2}px`;
      light.style.height = `${box.height + pad * 2}px`;
    });
  }, [stop]);
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
      else if (event.key === 'ArrowRight' && !last) setIndex((value) => value + 1);
      else if (event.key === 'ArrowLeft') setIndex((value) => Math.max(0, value - 1));
    };
    window.addEventListener('keydown', key);
    return () => {
      window.removeEventListener('keydown', key);
    };
  }, [last, onClose]);

  if (stop === undefined) return null;
  return (
    <>
      <div ref={spotlight} className={styles.spotlight} aria-hidden="true" />
      <div
        ref={card}
        className={styles.coach}
        role="dialog"
        aria-modal="false"
        aria-labelledby="tour-title"
        aria-describedby="tour-body"
        tabIndex={-1}
      >
        <div className={styles.coachTop}>
          <span className={styles.coachCount}>
            Step {index + 1} of {available.length}
          </span>
          <button type="button" className={styles.coachSkip} onClick={onClose}>
            End tour
          </button>
        </div>
        <div className={styles.coachProgress} aria-hidden="true">
          {available.map((item, position) => (
            <span key={item.target} data-on={position <= index} />
          ))}
        </div>
        <h2 id="tour-title" className={styles.coachTitle} key={stop.target}>
          {stop.title}
        </h2>
        <p id="tour-body" className={styles.coachBody}>
          {stop.body}
        </p>
        <div className={styles.coachActions}>
          <button
            type="button"
            className={styles.ghostButton}
            disabled={index === 0}
            onClick={() => {
              setIndex((value) => Math.max(0, value - 1));
            }}
          >
            Back
          </button>
          <button
            type="button"
            className={styles.solidButton}
            onClick={() => {
              if (last) onClose();
              else setIndex((value) => value + 1);
            }}
          >
            {last ? 'Finish tour' : 'Next'}
          </button>
        </div>
      </div>
    </>
  );
}
