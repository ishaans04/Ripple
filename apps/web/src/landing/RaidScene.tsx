import { useState, type CSSProperties } from 'react';
import { prefersReducedMotion } from '../motion/scroll.ts';
import styles from './Landing.module.css';

const order = (index: number) => ({ '--reveal-order': index }) as CSSProperties;

const routes = [
  { id: 'first', d: 'M 170 300 C 300 120, 470 110, 560 210', duration: '4.6s', begin: '0s' },
  { id: 'second', d: 'M 560 210 C 660 300, 760 420, 860 360', duration: '4.6s', begin: '2.3s' },
] as const;

const beats = [
  {
    title: 'The parent stays home',
    detail: 'A raid copies a descendant onto the trip. Your community keeps its resident.',
  },
  {
    title: 'The receiving chat decides',
    detail: 'Visitor policy can ask, accept or reject. Asking opens a welcome vote.',
  },
  {
    title: 'Survivors leave a trace',
    detail: 'A visitor that thrives can mark its host. Marks fade; lineage remembers.',
  },
] as const;

export function RaidScene() {
  const [still] = useState(prefersReducedMotion);
  return (
    <section id="raids" className={styles.raids} aria-labelledby="raids-title">
      <div className={styles.sectionHead}>
        <p className={styles.sectionTag} data-reveal="">
          <span>04</span> Raids
        </p>
        <h2 id="raids-title" className={styles.sectionTitle} data-reveal="" style={order(1)}>
          Raids carry <em>descendants.</em>
        </h2>
      </div>
      <div className={styles.raidMap} data-reveal="" style={order(2)} aria-hidden="true">
        <svg viewBox="0 80 1000 400">
          <defs>
            {routes.map((route) => (
              <path key={route.id} id={`raid-${route.id}`} d={route.d} />
            ))}
          </defs>
          {routes.map((route) => (
            <use key={route.id} href={`#raid-${route.id}`} className={styles.raidPath} />
          ))}
          {[
            { x: 170, y: 300, label: 'Home channel', home: true },
            { x: 560, y: 210, label: 'Raided channel', home: false },
            { x: 860, y: 360, label: 'Next host', home: false },
          ].map((node) => (
            <g key={node.label} className={styles.raidNode} data-home={node.home}>
              <circle cx={node.x} cy={node.y} r="54" className={styles.raidHalo} />
              <circle cx={node.x} cy={node.y} r="30" className={styles.raidCore} />
              <text x={node.x} y={node.y + 92} textAnchor="middle">
                {node.label}
              </text>
            </g>
          ))}
          {!still &&
            routes.map((route) => (
              <circle key={route.id} r="11" className={styles.raidTraveller}>
                <animateMotion
                  dur={route.duration}
                  begin={route.begin}
                  repeatCount="indefinite"
                  keyPoints="0;1;1"
                  keyTimes="0;0.5;1"
                  calcMode="spline"
                  keySplines="0.65 0 0.35 1;0 0 1 1"
                >
                  <mpath href={`#raid-${route.id}`} />
                </animateMotion>
              </circle>
            ))}
        </svg>
      </div>
      <ol className={styles.raidBeats}>
        {beats.map((beat, index) => (
          <li key={beat.title} data-reveal="" style={order(index)}>
            <span className={styles.raidBeatIndex}>{String.fromCharCode(97 + index)}</span>
            <strong>{beat.title}</strong>
            <span>{beat.detail}</span>
          </li>
        ))}
      </ol>
    </section>
  );
}
