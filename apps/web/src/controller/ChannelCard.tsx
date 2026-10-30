import type { ChannelView } from '@ripple/contracts';
import { Creature, markSummary } from '../creature/Creature.tsx';
import { familyRemainingText, familyUpdateText } from '../realtime/family-text.ts';
import styles from './Controller.module.css';
import { PropagationCard } from './PropagationCard.tsx';
import { RoundAnalysisCard } from './RoundAnalysisCard.tsx';
import { MechanicsCard } from './MechanicsCard.tsx';
export function ChannelCard({ channel }: { channel: ChannelView }) {
  const creature = channel.organism,
    round = channel.round;
  return (
    <section className={styles.panel} aria-label="Channel state">
      <h2>{channel.label}</h2>
      <p>
        {channel.mode === 'sandbox' ? 'Synthetic world · ' : ''}
        {channel.online ? 'Stream live' : 'Stream offline'} ·{' '}
        {channel.healthy ? 'Inputs healthy' : 'Inputs held'} ·{' '}
        {channel.paused ? 'Manually paused' : 'Automatic clock'}
      </p>
      {creature === null ? (
        <p>No resident strain. The broadcaster can seed when the stream and inputs are ready.</p>
      ) : (
        <>
          <h3>{creature.name}</h3>
          <div className={styles.creature}>
            <Creature organism={creature} />
          </div>
          {creature.marks !== undefined && <p>{markSummary(creature.marks)}</p>}
          <p>
            Energy {creature.health}/100 · {creature.status}
          </p>
          <p>
            Pulse {creature.genome.pulse} · Calm {creature.genome.calm} · Grit{' '}
            {creature.genome.grit} · Drift {creature.genome.drift}
          </p>
        </>
      )}
      {channel.familyDigest !== undefined && channel.familyDigest !== null && (
        <section aria-label="Family news since last stream">
          <h3>Family news since last stream</h3>
          <ul>
            {channel.familyDigest.items.map((item) => (
              <li key={`${item.lineageId}-${item.sequence}`}>{familyUpdateText(item)}</li>
            ))}
          </ul>
          {familyRemainingText(channel.familyDigest) !== null && (
            <p>{familyRemainingText(channel.familyDigest)}</p>
          )}
        </section>
      )}
      {round !== null && (
        <>
          <h3>
            Round {round.number} · {round.kind ?? 'MUTATION'} · {round.phase}
          </h3>
          {round.clock.paused && (
            <p>Clock held. Committed genes stay; incomplete observations do not change energy.</p>
          )}
          {round.phase === 'VOTING' && (
            <>
              <p>Vote in Twitch chat. Your first valid vote stands.</p>
              <ol>
                {round.candidates.map((c, i) => {
                  const estimate =
                    round.choicePreview?.status === 'estimate'
                      ? round.choicePreview.cards[i]
                      : undefined;
                  return (
                    <li key={i}>
                      <strong>{c.effect}</strong> — {c.tradeOff}. Vote !ripple {i + 1} ·{' '}
                      {round.counts[i] ?? 0} votes
                      {c.source === 'dormant' && (
                        <p>
                          Minority-preserved option from an earlier ballot. This is its only offer.
                        </p>
                      )}
                      {estimate !== undefined && (
                        <p>
                          Estimated energy change {signed(estimate.estimatedEnergyChange)};{' '}
                          {signed(estimate.relativeToHold)} compared with Hold.
                        </p>
                      )}
                    </li>
                  );
                })}
              </ol>
              {round.choicePreview !== undefined && (
                <p>
                  {round.choicePreview.status === 'learning'
                    ? `Learning: ${round.choicePreview.reason}.`
                    : `${round.choicePreview.label}.`}{' '}
                  {round.choicePreview.uncertainty}
                </p>
              )}
              {round.traceCleared !== undefined && (
                <p>The habitat trace was cleared after these estimates were made.</p>
              )}
              <p>
                {round.voteCloseAtMs === null
                  ? 'Voting clock is held.'
                  : `Voting closes at ${new Date(round.voteCloseAtMs).toLocaleTimeString()}.`}
              </p>
            </>
          )}
          {round.analysis !== undefined && round.analysis !== null ? (
            <RoundAnalysisCard analysis={round.analysis} />
          ) : round.explanation !== null ? (
            <p>{round.explanation.headline}</p>
          ) : null}
        </>
      )}
      {channel.propagation !== undefined && <PropagationCard view={channel.propagation} />}
      {channel.mechanics?.version === 1 && channel.mechanics.state !== undefined && (
        <MechanicsCard state={channel.mechanics.state} enabled={channel.mechanics.tracesEnabled} />
      )}
    </section>
  );
}
function signed(value: number): string {
  return value > 0 ? `+${value}` : String(value);
}
