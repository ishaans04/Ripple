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

export function Landing() {
  return (
    <main className={styles.page}>
      <header className={styles.hero}>
        <p className={styles.eyebrow}>A Twitch evolution game</p>
        <h1 className={styles.title}>Ripple</h1>
        <p className={styles.pitch}>
          Communities shape living strains. Raids carry their descendants. Every host changes the
          lineage, and successful visitors leave a trace for those who follow.
        </p>
      </header>

      <section className={styles.panel} aria-labelledby="loop-heading">
        <h2 id="loop-heading" className={styles.panelHeading}>
          How a lineage grows
        </h2>
        <ol className={styles.loop}>
          {lineageLoop.map(({ step, detail }) => (
            <li key={step} className={styles.loopItem}>
              <span className={styles.loopStep}>{step}</span>
              <span className={styles.loopDetail}>{detail}</span>
            </li>
          ))}
        </ol>
      </section>
    </main>
  );
}
