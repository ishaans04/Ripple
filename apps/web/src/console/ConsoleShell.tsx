import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { prefersReducedMotion } from '../motion/scroll.ts';
import { nextStep, type GuideStep, type StepState, type TourStop } from './guide.ts';
import { Tour } from './Tour.tsx';
import styles from './Console.module.css';

const stateLabels: Record<StepState, string> = {
  done: 'Done',
  next: 'Do this now',
  todo: 'Waiting',
  optional: 'Optional',
  locked: 'Unavailable',
};

/** Scrolls a section into view and briefly outlines it so the eye lands on it. */
export function revealSection(id: string) {
  const section = document.getElementById(id);
  if (section === null) return;
  section.scrollIntoView({
    block: 'start',
    behavior: prefersReducedMotion() ? 'auto' : 'smooth',
  });
  // Clearing first and setting on the next frame restarts the outline on repeated presses.
  delete section.dataset.flash;
  requestAnimationFrame(() => {
    section.dataset.flash = '';
    window.setTimeout(() => {
      delete section.dataset.flash;
    }, 1800);
  });
}

function readFlag(key: string): boolean {
  try {
    return localStorage.getItem(key) === '1';
  } catch {
    return false;
  }
}
function writeFlag(key: string) {
  try {
    localStorage.setItem(key, '1');
  } catch {
    /* The welcome simply appears again next time. */
  }
}

/**
 * The shared console frame: a rail of chapters whose states come from real data, an Up next
 * card, an inline first-visit welcome and an on-demand tour. `?tour=1` starts the tour on
 * load, for recorded walkthroughs.
 */
export function ConsoleShell({
  label,
  storageKey,
  steps,
  tour,
  welcome,
  extraNext,
  links,
  children,
}: {
  label: string;
  storageKey: string;
  steps: readonly GuideStep[];
  tour: readonly TourStop[];
  welcome: string;
  /** Shown in the Up next card when no step is next, such as after everything is done. */
  extraNext?: ReactNode;
  links: readonly { href: string; label: string }[];
  children: ReactNode;
}) {
  const [touring, setTouring] = useState(false);
  const [welcomed, setWelcomed] = useState(() => readFlag(`ripple:${storageKey}:welcomed`));
  useEffect(() => {
    if (new URLSearchParams(location.search).get('tour') !== '1') return;
    // Let the sections render their first data before measuring them.
    const timer = window.setTimeout(() => {
      setTouring(true);
    }, 600);
    return () => {
      window.clearTimeout(timer);
    };
  }, []);
  const dismiss = useCallback(() => {
    writeFlag(`ripple:${storageKey}:welcomed`);
    setWelcomed(true);
  }, [storageKey]);
  const close = useCallback(() => {
    setTouring(false);
    dismiss();
  }, [dismiss]);
  const next = nextStep(steps);
  const done = steps.filter((step) => step.state === 'done').length;
  const required = steps.filter((step) => step.state !== 'optional').length;
  return (
    <div className={styles.console} data-touring={touring}>
      <aside className={styles.rail}>
        <div className={styles.railHead}>
          <a href="/" className={styles.brand}>
            <span className={styles.brandMark} aria-hidden="true" />
            Ripple
          </a>
          <span className={styles.railLabel}>{label}</span>
        </div>
        <nav id="guide-rail" aria-label="Console chapters" className={styles.chapters}>
          <p className={styles.railMeter}>
            <span>
              {done} of {required} done
            </span>
            <span className={styles.meter} aria-hidden="true">
              <span
                className={styles.meterFill}
                style={{ transform: `scaleX(${required === 0 ? 0 : done / required})` }}
              />
            </span>
          </p>
          <ol>
            {steps.map((step, index) => (
              <li key={step.id} data-state={step.state}>
                <a
                  href={`#${step.target}`}
                  onClick={(event) => {
                    event.preventDefault();
                    revealSection(step.target);
                  }}
                >
                  <span className={styles.chapterMark} aria-hidden="true">
                    {step.state === 'done' ? '✓' : String(index + 1)}
                  </span>
                  <span className={styles.chapterText}>
                    <span className={styles.chapterTitle}>{step.title}</span>
                    <span className={styles.chapterState}>{stateLabels[step.state]}</span>
                  </span>
                </a>
              </li>
            ))}
          </ol>
        </nav>
        <section id="next-step" className={styles.nextCard} aria-labelledby="next-step-title">
          <p className={styles.nextEyebrow}>
            <span className={styles.nextPulse} aria-hidden="true" />
            Up next
          </p>
          {next === null ? (
            <>
              <h2 id="next-step-title" className={styles.nextTitle}>
                {steps.every((step) => step.state === 'locked')
                  ? 'Nothing to do here yet'
                  : 'All required steps are done'}
              </h2>
              {extraNext}
            </>
          ) : (
            <>
              <h2 id="next-step-title" className={styles.nextTitle}>
                {next.title}
              </h2>
              <p className={styles.nextDetail}>{next.detail}</p>
              <button
                type="button"
                className={styles.solidButton}
                onClick={() => {
                  revealSection(next.target);
                }}
              >
                Show me <span aria-hidden="true">↓</span>
              </button>
            </>
          )}
        </section>
        <div className={styles.railFoot}>
          <button
            type="button"
            className={styles.tourButton}
            onClick={() => {
              setTouring(true);
            }}
          >
            <span aria-hidden="true">▶</span> Start guided tour
          </button>
          <nav aria-label="Other Ripple pages" className={styles.railLinks}>
            {links.map((link) => (
              <a key={link.href} href={link.href}>
                {link.label}
              </a>
            ))}
          </nav>
        </div>
      </aside>
      <div className={styles.main}>
        {!welcomed && !touring && (
          <section className={styles.welcome} aria-labelledby="welcome-title">
            <div>
              <h2 id="welcome-title">First time here?</h2>
              <p>{welcome}</p>
            </div>
            <div className={styles.welcomeActions}>
              <button
                type="button"
                className={styles.solidButton}
                onClick={() => {
                  setTouring(true);
                }}
              >
                Take the tour
              </button>
              <button type="button" className={styles.ghostButton} onClick={dismiss}>
                Dismiss
              </button>
            </div>
          </section>
        )}
        {children}
      </div>
      {touring && <Tour stops={tour} onClose={close} />}
    </div>
  );
}

/** A numbered chapter of a console page; the guide and tour point at its id. */
export function ConsoleSection({
  id,
  index,
  title,
  lead,
  children,
}: {
  id: string;
  index: string;
  title: string;
  lead: string;
  children: ReactNode;
}) {
  return (
    <div id={id} className={styles.section}>
      <div className={styles.sectionHead}>
        <span className={styles.sectionIndex}>{index}</span>
        <div>
          <p className={styles.sectionTitle}>{title}</p>
          <p className={styles.sectionLead}>{lead}</p>
        </div>
      </div>
      <div className={styles.sectionBody}>{children}</div>
    </div>
  );
}
