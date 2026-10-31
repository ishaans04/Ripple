import { useEffect, useRef } from 'react';
import { onScrollFrame, sectionProgress } from '../motion/scroll.ts';
import styles from './Landing.module.css';

const lineageLoop = [
  { step: 'Seed', detail: 'A streamer names a founding strain for their community.' },
  { step: 'Choose', detail: 'Chat votes on one of three mutations with !ripple 1, 2, or 3.' },
  { step: 'Observe', detail: "The channel's real chat rhythm becomes the habitat." },
  { step: 'Adapt', detail: 'Energy rises or falls with how well the strain fits.' },
  {
    step: 'Raid',
    detail: 'A real raid carries a descendant to another channel. The parent stays home.',
  },
  { step: 'Welcome', detail: 'The receiving chat decides how the visitor arrives.' },
  { step: 'Inherit', detail: 'Descendants keep their origin mark and a readable history.' },
  {
    step: 'Leave a trace',
    detail: 'A visitor that survives can leave a temporary mark on its host.',
  },
] as const;

/** One small authored glyph per step; drawn with strokes so it animates cheaply. */
function Glyph({ index }: { index: number }) {
  const common = {
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 3,
    strokeLinecap: 'round' as const,
  };
  return (
    <svg viewBox="0 0 120 120" className={styles.glyph} aria-hidden="true">
      {index === 0 && (
        <>
          <circle cx="60" cy="60" r="10" fill="currentColor" />
          <circle cx="60" cy="60" r="28" {...common} className={styles.glyphRing} />
          <circle cx="60" cy="60" r="46" {...common} className={styles.glyphRing} />
        </>
      )}
      {index === 1 &&
        [30, 60, 90].map((x, choice) => (
          <g key={x} className={styles.glyphBar} data-choice={choice}>
            <rect x={x - 9} y="30" width="18" height="60" rx="9" {...common} />
          </g>
        ))}
      {index === 2 && (
        <path
          d="M 8 60 Q 23 20 38 60 T 68 60 T 98 60 T 128 60"
          {...common}
          className={styles.glyphWave}
        />
      )}
      {index === 3 && (
        <>
          <path d="M 20 92 L 20 28 M 20 92 L 100 92" {...common} />
          <path d="M 28 80 L 48 64 L 64 72 L 96 36" {...common} className={styles.glyphDraw} />
        </>
      )}
      {index === 4 && (
        <>
          <circle cx="24" cy="84" r="12" {...common} />
          <circle cx="96" cy="36" r="12" {...common} />
          <path d="M 36 78 Q 72 76 86 46" {...common} strokeDasharray="4 8" />
          <circle cx="36" cy="78" r="6" fill="currentColor" className={styles.glyphTraveller} />
        </>
      )}
      {index === 5 && (
        <>
          <path d="M 20 60 L 50 60" {...common} className={styles.glyphArrive} />
          <path d="M 60 30 A 30 30 0 1 1 60 90 A 30 30 0 1 1 60 30" {...common} />
          <circle cx="60" cy="60" r="8" fill="currentColor" />
        </>
      )}
      {index === 6 && (
        <>
          <path d="M 60 20 L 60 52 M 60 52 L 30 84 M 60 52 L 90 84" {...common} />
          {[
            [60, 20],
            [30, 88],
            [90, 88],
          ].map(([x = 0, y = 0]) => (
            <circle key={`${x}-${y}`} cx={x} cy={y} r="8" fill="currentColor" />
          ))}
        </>
      )}
      {index === 7 && (
        <>
          <path
            d="M 30 30 L 90 90 M 90 30 L 30 90"
            {...common}
            className={styles.glyphDraw}
            strokeDasharray="90"
          />
          <circle cx="60" cy="60" r="42" {...common} strokeDasharray="6 10" />
        </>
      )}
    </svg>
  );
}

/**
 * The loop scrolls sideways while its section is pinned. The section height equals the
 * sideways travel plus one viewport, so the track moves exactly with the reader's scroll.
 * Narrow screens and reduced motion get an ordinary vertical list.
 */
export function LoopTrack() {
  const section = useRef<HTMLElement>(null);
  const track = useRef<HTMLDivElement>(null);
  const cards = useRef<HTMLOListElement>(null);
  const bar = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    const host = section.current,
      list = track.current;
    if (host === null || list === null) return;
    const wide = window.matchMedia(
      '(min-width: 760px) and (prefers-reduced-motion: no-preference)',
    );
    let travel = 0,
      active = -1,
      stop: (() => void) | null = null;
    const measure = () => {
      travel = Math.max(0, list.scrollWidth - window.innerWidth);
      host.style.height = `${travel + window.innerHeight}px`;
    };
    const attach = () => {
      stop?.();
      stop = null;
      if (!wide.matches) {
        host.style.height = '';
        list.style.transform = '';
        host.dataset.pinned = 'false';
        return;
      }
      host.dataset.pinned = 'true';
      measure();
      let lastWidth = window.innerWidth;
      stop = onScrollFrame((_scrollY, viewport) => {
        if (window.innerWidth !== lastWidth) {
          lastWidth = window.innerWidth;
          measure();
        }
        const progress = sectionProgress(host.getBoundingClientRect(), viewport, 'pin');
        list.style.transform = `translate3d(${(-progress * travel).toFixed(1)}px, 0, 0)`;
        if (bar.current) bar.current.style.transform = `scaleX(${progress.toFixed(4)})`;
        const next = Math.min(
          lineageLoop.length - 1,
          Math.floor(progress * lineageLoop.length * 0.999),
        );
        if (next !== active) {
          active = next;
          for (const [index, card] of Array.from(cards.current?.children ?? []).entries())
            (card as HTMLElement).dataset.active = String(index === next);
        }
      });
    };
    attach();
    wide.addEventListener('change', attach);
    return () => {
      stop?.();
      wide.removeEventListener('change', attach);
    };
  }, []);
  return (
    <section ref={section} id="loop" className={styles.loopSection} aria-labelledby="loop-heading">
      <div className={styles.loopSticky}>
        <div ref={track} className={styles.loopTrack}>
          <div className={styles.loopIntro}>
            <p className={styles.sectionTag}>
              <span>02</span> The loop
            </p>
            <h2 id="loop-heading" className={styles.sectionTitle}>
              How a lineage <em>grows</em>
            </h2>
            <p className={styles.loopLead}>
              Eight beats, repeated across every channel that welcomes the strain. Keep scrolling.
            </p>
          </div>
          <ol ref={cards} className={styles.loopCards}>
            {lineageLoop.map(({ step, detail }, index) => (
              <li key={step} className={styles.loopCard} data-active="false">
                <span className={styles.loopIndex}>{String(index + 1).padStart(2, '0')}</span>
                <Glyph index={index} />
                <span className={styles.loopStep}>{step}</span>
                <span className={styles.loopDetail}>{detail}</span>
              </li>
            ))}
          </ol>
        </div>
        <div className={styles.loopRail} aria-hidden="true">
          <span ref={bar} className={styles.loopBar} />
        </div>
      </div>
    </section>
  );
}
