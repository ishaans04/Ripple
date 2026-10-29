import type { ChannelView } from '@ripple/contracts';
import { ShellRenderer } from '../studio/ShellRenderer.tsx';
import styles from './Controller.module.css';
import { PropagationCard } from './PropagationCard.tsx';
export function ChannelCard({ channel }: { channel: ChannelView }) {
  const creature = channel.organism,
    round = channel.round;
  const design =
    creature?.appearance.kind === 'studio' ? creature.appearance.blueprint : creature?.appearance;
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
            {design !== undefined && (
              <ShellRenderer part={design.part} rendererVersion={design.rendererVersion} />
            )}
          </div>
          <p>
            Energy {creature.health}/100 · {creature.status}
          </p>
          <p>
            Pulse {creature.genome.pulse} · Calm {creature.genome.calm} · Grit{' '}
            {creature.genome.grit} · Drift {creature.genome.drift}
          </p>
        </>
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
          {round.explanation !== null && <p>{round.explanation.headline}</p>}
        </>
      )}
      {channel.propagation !== undefined && <PropagationCard view={channel.propagation} />}
    </section>
  );
}
function signed(value: number): string {
  return value > 0 ? `+${value}` : String(value);
}
