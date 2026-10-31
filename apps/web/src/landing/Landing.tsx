import { useEffect, useRef, type CSSProperties } from 'react';
import { founderShell } from '@ripple/contracts';
import { ShellRenderer } from '../studio/ShellRenderer.tsx';
import { onScrollFrame, useReveal, useScrollProgress } from '../motion/scroll.ts';
import styles from './Landing.module.css';
import { Pond } from './Pond.tsx';
import { LoopTrack } from './LoopTrack.tsx';
import { StudioScene } from './StudioScene.tsx';
import { RaidScene } from './RaidScene.tsx';
import { ServiceStatusPanel } from './ServiceStatusPanel.tsx';

const order = (index: number) => ({ '--reveal-order': index }) as CSSProperties;

function SiteNav() {
  const ref = useRef<HTMLElement>(null);
  useEffect(() => {
    const header = ref.current;
    if (header === null) return;
    let last = window.scrollY;
    return onScrollFrame((scrollY) => {
      // Hide while reading downwards; return as soon as the reader scrolls back up.
      if (Math.abs(scrollY - last) < 6) return;
      header.dataset.hidden = String(scrollY > last && scrollY > 240);
      header.dataset.solid = String(scrollY > 40);
      last = scrollY;
    });
  }, []);
  return (
    <header ref={ref} className={styles.nav}>
      <a href="/" className={styles.navBrand}>
        <span className={styles.navMark} aria-hidden="true" />
        Ripple
      </a>
      <nav aria-label="Primary" className={styles.navLinks}>
        <a href="#loop">How it works</a>
        <a href="#studio">Studio</a>
        <a href="#raids">Raids</a>
        <a href="/sandbox">Sandbox</a>
      </nav>
      <a href="/controller" className={styles.navCta}>
        Enter the console
      </a>
    </header>
  );
}

function Hero() {
  const ref = useScrollProgress<HTMLElement>('pass');
  useEffect(() => {
    const hero = ref.current;
    if (hero === null || !window.matchMedia('(pointer: fine)').matches) return;
    let frame: number | null = null,
      x = 0,
      y = 0;
    const move = (event: PointerEvent) => {
      x = event.clientX / window.innerWidth - 0.5;
      y = event.clientY / window.innerHeight - 0.5;
      frame ??= requestAnimationFrame(() => {
        frame = null;
        hero.style.setProperty('--px', x.toFixed(3));
        hero.style.setProperty('--py', y.toFixed(3));
      });
    };
    hero.addEventListener('pointermove', move, { passive: true });
    return () => {
      hero.removeEventListener('pointermove', move);
      if (frame !== null) cancelAnimationFrame(frame);
    };
  }, [ref]);
  return (
    <section ref={ref} className={styles.hero} aria-labelledby="hero-title">
      <Pond />
      <div className={styles.heroTop}>
        <p className={styles.kicker}>
          <span className={styles.pulse} aria-hidden="true" />A Twitch evolution game
        </p>
        <p className={styles.heroPitch}>
          Communities shape living strains. Raids carry their descendants. Every host changes the
          lineage, and successful visitors leave a trace for those who follow.
        </p>
      </div>
      <div className={styles.heroCreature} aria-hidden="true">
        <span className={styles.orbit} />
        <span className={styles.orbit} />
        <div className={styles.bob}>
          <ShellRenderer part={founderShell} label="Founding strain" />
        </div>
      </div>
      <h1 id="hero-title" className={styles.wordmark}>
        {'Ripple'.split('').map((letter, index) => (
          <span key={index} className={styles.letter} style={{ '--i': index } as CSSProperties}>
            <span>{letter}</span>
          </span>
        ))}
      </h1>
      <div className={styles.heroFoot}>
        <div className={styles.heroActions}>
          <a href="/controller" className={styles.primary}>
            Enter the console <span aria-hidden="true">→</span>
          </a>
          <a href="/sandbox" className={styles.ghost}>
            Try a three-minute expedition
          </a>
        </div>
        <p className={styles.scrollCue}>
          <span aria-hidden="true" className={styles.scrollLine} />
          Scroll to follow a lineage
        </p>
      </div>
    </section>
  );
}

const tickerWords = [
  '!ripple 1',
  'mutate',
  '!ripple 2',
  'observe',
  '!ripple 3',
  'adapt',
  'raid',
  'welcome',
  'inherit',
  'leave a trace',
];

function Marquee() {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const band = ref.current;
    if (band === null) return;
    let last = window.scrollY,
      settle: ReturnType<typeof setTimeout> | undefined;
    const stop = onScrollFrame((scrollY) => {
      const velocity = scrollY - last;
      last = scrollY;
      band.style.setProperty(
        '--skew',
        `${Math.max(-7, Math.min(7, velocity * 0.18)).toFixed(2)}deg`,
      );
      clearTimeout(settle);
      settle = setTimeout(() => {
        band.style.setProperty('--skew', '0deg');
      }, 140);
    });
    return () => {
      stop();
      clearTimeout(settle);
    };
  }, []);
  const run = (copy: number) =>
    tickerWords.map((word) => (
      <span key={`${copy}-${word}`} className={styles.tick}>
        {word}
        <span className={styles.tickStar}>✺</span>
      </span>
    ));
  return (
    <div ref={ref} className={styles.marquee} aria-hidden="true">
      <div className={styles.marqueeTrack}>
        {run(0)}
        {run(1)}
      </div>
    </div>
  );
}

const manifesto =
  'Ripple is a living strain that belongs to a whole chat. Votes choose its mutations. The chat’s own rhythm becomes its habitat. Raids carry a descendant out into the world while the parent stays home, and every visitor that survives leaves a trace behind.';
const highlighted = new Set(['whole', 'chat.', 'mutations.', 'habitat.', 'descendant', 'trace']);

function Manifesto() {
  const words = manifesto.split(' ');
  const container = useRef<HTMLParagraphElement>(null);
  const ref = useScrollProgress<HTMLElement>('pass', (progress) => {
    const spans = container.current?.children;
    if (spans === undefined) return;
    // Words light from the first quarter of the pass to just past the middle.
    const lit = Math.round(Math.max(0, Math.min(1, (progress - 0.18) / 0.42)) * spans.length);
    for (let index = 0; index < spans.length; index++) {
      const span = spans[index] as HTMLElement;
      const on = index < lit;
      if ((span.dataset.lit === 'true') !== on) span.dataset.lit = String(on);
    }
  });
  return (
    <section ref={ref} className={styles.manifesto} aria-label="What Ripple is">
      <p className={styles.sectionTag}>
        <span>01</span> The idea
      </p>
      <p ref={container} className={styles.manifestoText}>
        {words.map((word, index) => (
          <span
            key={index}
            className={highlighted.has(word) ? styles.keyWord : styles.word}
            data-lit="false"
          >
            {word}{' '}
          </span>
        ))}
      </p>
    </section>
  );
}

const surfaces = [
  {
    href: '/controller',
    who: 'For streamers',
    title: 'The console',
    detail:
      'Connect Twitch, seed a strain, set visitor policy and copy one private OBS overlay link. A guide walks you through each step.',
    cta: 'Open the console',
  },
  {
    href: '/studio',
    who: 'For artists',
    title: 'Cocoon Studio',
    detail:
      'Sculpt a shell with your hands through the camera, or with pointer, touch and keyboard. Practice designs stay on your device.',
    cta: 'Open the practice studio',
  },
  {
    href: '/sandbox',
    who: 'For anyone',
    title: 'The sandbox',
    detail:
      'No account. Vote, change habitat, raid, build a shell and verify its replay in your own synthetic world.',
    cta: 'Try sandbox',
  },
] as const;

function Surfaces() {
  return (
    <section className={styles.surfaces} aria-labelledby="surfaces-title">
      <div className={styles.sectionHead}>
        <p className={styles.sectionTag} data-reveal="">
          <span>05</span> Where you play
        </p>
        <h2 id="surfaces-title" className={styles.sectionTitle} data-reveal="" style={order(1)}>
          Three doors into <em>one living world.</em>
        </h2>
      </div>
      <div className={styles.surfaceGrid}>
        {surfaces.map((surface, index) => (
          <a
            key={surface.href}
            href={surface.href}
            className={styles.surface}
            data-reveal=""
            style={order(index)}
            onPointerMove={(event) => {
              const box = event.currentTarget.getBoundingClientRect();
              event.currentTarget.style.setProperty('--mx', `${event.clientX - box.left}px`);
              event.currentTarget.style.setProperty('--my', `${event.clientY - box.top}px`);
            }}
          >
            <span className={styles.surfaceWho}>{surface.who}</span>
            <span className={styles.surfaceTitle}>{surface.title}</span>
            <span className={styles.surfaceDetail}>{surface.detail}</span>
            <span className={styles.surfaceCta}>
              {surface.cta} <span aria-hidden="true">↗</span>
            </span>
          </a>
        ))}
      </div>
    </section>
  );
}

const facts = [
  { value: '3', label: 'choices on every ballot', detail: 'Chat answers with !ripple 1, 2 or 3.' },
  {
    value: '1',
    label: 'descendant per raid',
    detail: 'The parent always stays home with its community.',
  },
  {
    value: '0',
    label: 'camera frames uploaded',
    detail: 'Hand tracking runs entirely inside your browser.',
  },
  {
    value: '∞',
    label: 'identical replays',
    detail: 'Accepted records rebuild the same lineage, every time.',
  },
] as const;

function Facts() {
  return (
    <section className={styles.facts} aria-labelledby="facts-title">
      <div className={styles.sectionHead}>
        <p className={styles.sectionTag} data-reveal="">
          <span>06</span> Promises
        </p>
        <h2 id="facts-title" className={styles.sectionTitle} data-reveal="" style={order(1)}>
          Fair by construction.
        </h2>
      </div>
      <dl className={styles.factGrid}>
        {facts.map((fact, index) => (
          <div key={fact.label} className={styles.fact} data-reveal="" style={order(index)}>
            <dt>
              <span className={styles.factValue}>{fact.value}</span>
              <span className={styles.factLabel}>{fact.label}</span>
            </dt>
            <dd>{fact.detail}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

function Finale() {
  return (
    <section className={styles.finale} aria-labelledby="finale-title">
      <p className={styles.sectionTag} data-reveal="">
        <span>07</span> Begin
      </p>
      <h2 id="finale-title" className={styles.finaleTitle} data-reveal="" style={order(1)}>
        Drop the first stone.
      </h2>
      <div className={styles.finaleActions} data-reveal="" style={order(2)}>
        <a href="/controller" className={styles.finaleCta}>
          <span>Enter the console</span>
          <span aria-hidden="true">→</span>
        </a>
        <a href="/studio" className={styles.ghost}>
          Open the practice studio
        </a>
      </div>
      <div className={styles.finaleStatus} data-reveal="" style={order(3)}>
        <ServiceStatusPanel />
      </div>
    </section>
  );
}

export function Landing() {
  const ref = useReveal<HTMLDivElement>();
  return (
    <div ref={ref} className={styles.site}>
      <SiteNav />
      <main className={styles.page}>
        <Hero />
        <Marquee />
        <Manifesto />
        <LoopTrack />
        <StudioScene />
        <RaidScene />
        <Surfaces />
        <Facts />
        <Finale />
      </main>
      <footer className={styles.footer}>
        <span className={styles.footerBrand}>Ripple</span>
        <span>Created by communities. Carried onward.</span>
        <nav aria-label="Footer" className={styles.footerLinks}>
          <a href="/privacy">Privacy and data deletion</a>
          <a href="/licenses/README.md">Licenses</a>
        </nav>
      </footer>
    </div>
  );
}
