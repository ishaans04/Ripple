import type { ChannelControl, ChannelView } from '@ripple/contracts';
import styles from './Controller.module.css';
export function TraceControls({
  channel,
  version,
  disabled,
  control,
}: {
  channel: ChannelView;
  version: number;
  disabled: boolean;
  control: (body: ChannelControl) => void;
}) {
  const mechanics = channel.mechanics;
  if (mechanics === undefined) return null;
  if (mechanics.version === 0)
    return (
      <section className={styles.panel} aria-label="Novel mechanics settings">
        <h2>Novel mechanics</h2>
        <p>
          {mechanics.enableRequested
            ? 'Enablement requested. The current round keeps its original rules; novel mechanics begin at the next safe round opening.'
            : 'This channel uses legacy mechanics. Enable traces, dormant possibilities and saved comparisons for future rounds.'}
        </p>
        <button
          disabled={disabled || mechanics.enableRequested}
          onClick={() => {
            control({ action: 'enableMechanics', expectedVersion: version });
          }}
        >
          Enable novel mechanics
        </button>
      </section>
    );
  return (
    <section className={styles.panel} aria-label="Habitat trace controls">
      <h2>Habitat traces</h2>
      <p>
        {mechanics.tracesEnabled
          ? 'Traces enabled. Only earned offers can activate after a chat decision.'
          : 'Traces disabled. Cleared offers stay cleared when you enable traces again.'}
      </p>
      <div className={styles.actions}>
        <button
          disabled={disabled}
          onClick={() => {
            control({ action: 'clearTrace', expectedVersion: version });
          }}
        >
          Clear habitat traces
        </button>
        <button
          disabled={disabled}
          onClick={() => {
            control({
              action: 'setTraces',
              enabled: !mechanics.tracesEnabled,
              expectedVersion: version,
            });
          }}
        >
          {mechanics.tracesEnabled ? 'Disable habitat traces' : 'Enable habitat traces'}
        </button>
      </div>
      <p>
        Clear removes the current effect and pending offers. An open trace decision is cancelled
        without applying a vote.
      </p>
    </section>
  );
}
