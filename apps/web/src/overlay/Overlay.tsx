import { useEffect, useState } from 'react';
import type { ChannelView } from '@ripple/contracts';
import { useReadChannel } from '../realtime/useReadChannel.ts';
import { traceEffectText, traceTitle } from '../realtime/trace-labels.ts';
import { ShellRenderer } from '../studio/ShellRenderer.tsx';
import styles from './Overlay.module.css';

const ballotTitle: Readonly<Record<string, string>> = {
  MUTATION: 'Mutation',
  WELCOME: 'Welcome',
  TRACE: 'Habitat trace',
  PREPARATION: 'Travel preparation',
};
function deadlineLabel(deadline: number | null, now: number, paused: boolean) {
  if (paused || deadline === null) return 'Voting clock held';
  const seconds = Math.max(0, Math.ceil((deadline - now) / 1000));
  if (seconds === 0) return 'Voting closed · awaiting confirmation';
  return `Closes in ${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
}
function Decision({ channel, now }: { channel: ChannelView; now: number }) {
  const round = channel.round;
  if (!channel.online) return <p>Stream offline · active time is frozen</p>;
  if (!channel.healthy || round?.phase === 'INTERRUPTED')
    return <p>Observation interrupted · waiting for broadcaster recovery</p>;
  if (channel.paused || round?.clock.paused === true)
    return <p>Game paused · committed adaptations stay</p>;
  if (round === null) return <p>No active round · waiting for a strain</p>;
  if (round.phase === 'VOTING') {
    const votes = round.counts.reduce((sum, count) => sum + count, 0);
    const mechanics = channel.mechanics?.state,
      offer = mechanics?.pendingTraces[0];
    return (
      <>
        <h2>{ballotTitle[round.kind ?? 'MUTATION'] ?? 'Community decision'}</h2>
        {round.kind === 'TRACE' && offer !== undefined && mechanics !== undefined && (
          <p>
            Offered {traceTitle[offer.template]} · earned by {offer.emitterName} from{' '}
            {offer.originLabel}. {traceEffectText(offer.template, mechanics.traceRules)}
          </p>
        )}
        <ol className={styles.choices}>
          {round.candidates.map((card, index) => (
            <li key={index}>
              <div className={styles.choiceHeading}>
                <strong>
                  {index + 1}. {card.effect}
                </strong>
                <span className={styles.votes}>
                  {round.counts[index] ?? 0} {(round.counts[index] ?? 0) === 1 ? 'vote' : 'votes'}
                </span>
              </div>
              <span>
                {card.tradeOff}
                {card.source === 'dormant' && ' · Minority-preserved; only offer'}
              </span>
            </li>
          ))}
        </ol>
        <p className={styles.action}>
          {round.voteCloseAtMs !== null && round.voteCloseAtMs <= now ? (
            'Waiting for the ballot result'
          ) : (
            <>
              Vote in chat: !ripple 1{round.candidates.length > 1 && ' or 2'}
              {round.candidates.length > 2 && ' or 3'}
            </>
          )}
        </p>
        <p>
          {deadlineLabel(round.voteCloseAtMs, now, round.clock.paused)} · {votes} votes received
        </p>
        {round.kind === 'TRACE' ? (
          <p>No votes: Clear. Only 1 Keep or 2 Clear is valid.</p>
        ) : round.kind === 'MUTATION' || round.kind === undefined ? (
          <p>No votes: Hold the current genome.</p>
        ) : round.kind === 'WELCOME' ? (
          <p>No votes: Conserve arrival energy.</p>
        ) : round.kind === 'PREPARATION' ? (
          <p>
            No votes: keep the standing travel choice (
            {channel.propagation?.preparation ?? 'unchanged'}).
          </p>
        ) : null}
      </>
    );
  }
  if (round.phase === 'OBSERVING')
    return (
      <>
        <h2>Observing habitat</h2>
        <p>Chat rhythm shapes this round. Ripple commands do not count as activity.</p>
      </>
    );
  if (round.analysis?.status === 'cancelled')
    return <p>Trace decision cancelled · no score applied</p>;
  if (round.explanation !== null)
    return (
      <>
        <h2>Round result</h2>
        <p>{round.explanation.headline}</p>
      </>
    );
  return <p>Settling the next round</p>;
}
export default function Overlay() {
  const { channel, status, serverOffsetMs } = useReadChannel(),
    [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = setInterval(() => {
      setNow(Date.now());
    }, 1000);
    return () => {
      clearInterval(timer);
    };
  }, []);
  const creature = channel?.organism,
    design =
      creature?.appearance.kind === 'studio' ? creature.appearance.blueprint : creature?.appearance,
    ancestry = channel?.propagation?.resident,
    trace = channel?.mechanics?.state?.activeTrace;
  return (
    <main className={styles.stage} aria-label="Ripple broadcast overlay">
      <section className={styles.corner}>
        {design !== undefined && (
          <div
            className={`${styles.creature} ${creature?.status === 'FOSSIL' ? styles.fossil : ''}`}
          >
            <ShellRenderer part={design.part} rendererVersion={design.rendererVersion} />
          </div>
        )}
        <div className={styles.panel}>
          <div className={styles.identity}>
            <h1>{creature?.name ?? channel?.label ?? 'Ripple'}</h1>
            {channel !== null && channel.mode !== 'live' && (
              <p className={styles.badge}>
                {channel.mode === 'sandbox' ? 'Synthetic world' : 'Recorded replay'}
              </p>
            )}
          </div>
          {creature !== undefined && creature !== null && (
            <p className={styles.energy}>
              Energy {creature.health}/100 ·{' '}
              {creature.status === 'FOSSIL' ? 'Fossil · history preserved' : creature.status}
            </p>
          )}
          {ancestry !== undefined && ancestry !== null && (
            <p>
              From {ancestry.originLabel} · generation {ancestry.generation}
            </p>
          )}
          {status === 'connected' && channel !== null ? (
            <>
              <Decision channel={channel} now={now + serverOffsetMs} />
              {channel.propagation?.visitor !== undefined &&
                channel.propagation.visitor !== null && (
                  <p>
                    Visitor: {channel.propagation.visitor.name} from{' '}
                    {channel.propagation.visitor.originLabel} ·{' '}
                    {channel.propagation.visitor.welcomed
                      ? 'sharing this habitat'
                      : 'awaiting welcome'}
                  </p>
                )}
              {trace !== undefined && trace !== null && (
                <p>
                  Trace: {trace.template} · {trace.remainingRounds} valid observations left
                </p>
              )}
              {(channel.mechanics?.state?.dormant.length ?? 0) > 0 && (
                <p>Dormant possibility preserved · no hidden protection</p>
              )}
            </>
          ) : (
            <p role="status">
              {status === 'invalid'
                ? 'Overlay link or renderer unsupported. Create a new link in the controller.'
                : status === 'unauthorized'
                  ? 'Overlay link expired or revoked. Create a new link in the controller.'
                  : status === 'connecting'
                    ? 'Connecting to Ripple…'
                    : 'Reconnecting · displaying last confirmed state'}
            </p>
          )}
        </div>
      </section>
    </main>
  );
}
