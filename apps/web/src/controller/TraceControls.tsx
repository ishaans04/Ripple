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
  if (mechanics?.version !== 1) return null;
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
