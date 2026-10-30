import type { Passport as PassportRecord } from '@ripple/contracts';
import { Creature, markSummary } from '../creature/Creature.tsx';
import { traceTitle } from '../realtime/trace-labels.ts';
import styles from './Lineage.module.css';

const statusText = {
  ALIVE: 'Living',
  HARBOR: 'Waiting in a harbor',
  FOSSIL: 'Fossil · history preserved',
  ARCHIVED: 'Archived',
} as const;
const dormantOutcome = {
  selected: 'chosen by the receiving community',
  rejected: 'offered and declined',
  replaced: 'replaced by a newer capture',
  fossil: 'ended when the branch fossilized',
  'valid-round-expiry': 'expired after three valid observations',
} as const;
const roleText = { resident: 'Resident', visitor: 'Visitor', harbor: 'Harbor wait' } as const;
const signed = (value: number) => (value > 0 ? `+${value}` : value < 0 ? `−${-value}` : '±0');
const genes = (genome: PassportRecord['organism']['genome']) =>
  `Pulse ${genome.pulse} · Calm ${genome.calm} · Grit ${genome.grit} · Drift ${genome.drift}`;
const when = (value: string) =>
  new Date(value).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });

export function Passport({
  passport,
  loadingOlder,
  onOlder,
}: {
  passport: PassportRecord;
  loadingOlder: boolean;
  onOlder: () => void;
}) {
  const { organism } = passport;
  return (
    <article className={styles.passport} aria-labelledby="passport-title">
      <header className={styles.passportHeader}>
        <div className={organism.status === 'FOSSIL' ? styles.fossilArt : styles.art}>
          <Creature organism={organism} />
        </div>
        <div>
          <h2 id="passport-title">{organism.name}</h2>
          <p>
            {statusText[organism.status]} · generation {organism.generation} · energy{' '}
            {organism.health}/100
          </p>
          <p>{genes(organism.genome)}</p>
          <p>Founding genome: {genes(organism.foundingGenome)}</p>
          <p>{markSummary(organism.marks)}</p>
          <p>Recorded {when(organism.createdAt)}</p>
        </div>
      </header>

      <section aria-labelledby="passport-family">
        <h3 id="passport-family">Family and travel</h3>
        <p>
          Origin: {passport.origin.label} ·{' '}
          {passport.parent === null
            ? 'founding strain of this lineage'
            : `founder ${passport.founder.name} · parent ${passport.parent.name} (${statusText[passport.parent.status]})`}
        </p>
        {passport.birth !== null && (
          <p>
            Born from a raid by {passport.birth.source.label} on {when(passport.birth.createdAt)}
            {passport.birth.destination === null
              ? ' to a channel that has not joined Ripple'
              : ` to ${passport.birth.destination.label}`}
            {passport.birth.historical ? ' · adopted later from an earlier raid' : ''}.
          </p>
        )}
        <p>Admitted hosts: {passport.hosts.map((item) => item.label).join(' → ')}</p>
        <ol className={styles.timeline}>
          {passport.residencies.map((stay) => (
            <li key={`${stay.channelId}-${stay.startedAt}-${stay.role}`}>
              {roleText[stay.role]} at {stay.label} · {when(stay.startedAt)}
              {stay.endedAt === null ? ' · current' : ` to ${when(stay.endedAt)}`}
            </li>
          ))}
        </ol>
      </section>

      <section aria-labelledby="passport-adaptations">
        <h3 id="passport-adaptations">
          Committed mutation decisions ({passport.adaptations.total})
        </h3>
        {passport.adaptations.total === 0 ? (
          <p>No mutation ballot has closed for this branch yet.</p>
        ) : (
          <ol className={styles.history}>
            {passport.adaptations.items.map((item) => (
              <li key={item.roundId}>
                <strong>Round {item.number}</strong> at {item.host.label}:{' '}
                {item.selection.status === 'selected' ? (
                  <>
                    {item.selection.effect} — {item.selection.tradeOff}
                    {item.selection.source === 'dormant' && ' · minority-preserved option'}.{' '}
                    {genes(item.genomeBefore)} became {genes(item.selection.genomeAfter)}.
                  </>
                ) : item.selection.status === 'hold' ? (
                  <>Hold · the genome stayed {genes(item.genomeBefore)}.</>
                ) : (
                  <>Selection not recorded for this older round.</>
                )}
              </li>
            ))}
          </ol>
        )}
        {passport.adaptations.next !== null && (
          <button type="button" onClick={onOlder} disabled={loadingOlder}>
            {loadingOlder ? 'Loading older decisions…' : 'Show older decisions'}
          </button>
        )}
      </section>

      <section aria-labelledby="passport-dormant">
        <h3 id="passport-dormant">Dormant captures ({passport.dormant.total})</h3>
        {passport.dormant.items.length === 0 ? (
          <p>No minority direction has been preserved for this branch.</p>
        ) : (
          <ul className={styles.history}>
            {passport.dormant.items.map((item) => (
              <li key={item.id}>
                {item.template.to} +{item.template.amount} / {item.template.from} −
                {item.template.amount} · {item.supporters} of {item.totalVotes} votes at{' '}
                {item.origin.label}
                {item.inherited ? ' · inherited' : ''} ·{' '}
                {item.status === 'active'
                  ? `${item.offered ? 'offered' : 'waiting'}, ${item.remainingRounds} valid observations left`
                  : item.outcome === null
                    ? item.status
                    : dormantOutcome[item.outcome]}
              </li>
            ))}
          </ul>
        )}
        {passport.dormant.total > passport.dormant.items.length && (
          <p>Showing the latest {passport.dormant.items.length} captures.</p>
        )}
      </section>

      <section aria-labelledby="passport-traces">
        <h3 id="passport-traces">Habitat traces emitted ({passport.traces.total})</h3>
        {passport.traces.items.length === 0 ? (
          <p>This branch has not earned a habitat trace.</p>
        ) : (
          <ul className={styles.history}>
            {passport.traces.items.map((item) => (
              <li key={item.id}>
                {traceTitle[item.template]} at {item.host.label} · {item.status}
                {item.status === 'active' || item.status === 'pending'
                  ? `, ${item.remainingRounds} valid observations left`
                  : ''}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section aria-labelledby="passport-trials">
        <h3 id="passport-trials">Ancestor trials ({passport.ancestorTrials.total})</h3>
        <p>
          Each trial scores the founding genome under the same recorded round. Shadows never change
          the game. Differences are current minus ancestor.
        </p>
        {passport.ancestorTrials.items.length === 0 ? (
          <p>No matched observation has been recorded for this branch.</p>
        ) : (
          <ul className={styles.history}>
            {passport.ancestorTrials.items.map((item) => (
              <li key={item.roundId}>
                Round {item.number} at {item.host.label}:{' '}
                {item.identicalGenome
                  ? 'identical to the founding genome'
                  : `fitness ${signed(item.fitnessDifference)}, energy ${signed(item.deltaDifference)}`}
              </li>
            ))}
          </ul>
        )}
      </section>
    </article>
  );
}
