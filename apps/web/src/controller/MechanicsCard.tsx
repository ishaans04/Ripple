import type { MechanicsState, TraceView } from '@ripple/contracts';
import styles from './Controller.module.css';

function TraceDetails({ trace, rules }: { trace: TraceView; rules: MechanicsState['traceRules'] }) {
  return (
    <>
      <p>
        <strong>
          {trace.template === 'charged'
            ? 'Charged habitat'
            : trace.template === 'shelter'
              ? 'Shelter'
              : 'Recovery zone'}
        </strong>{' '}
        · {trace.remainingRounds} valid observations remaining · {trace.status}
      </p>
      <p>
        {trace.template === 'charged'
          ? `Fitness +${rules.chargedAdjustment} when burst is at least ${rules.chargedBurstThreshold}; fitness -${rules.chargedAdjustment} otherwise.`
          : trace.template === 'shelter'
            ? `Arrival raw shock reduced by ${rules.shelterArrivalShockReduction}; upkeep increases by ${rules.shelterUpkeep}.`
            : `Energy delta +${rules.recoveryAdjustment} below ${rules.recoveryHealthThreshold} start energy; -${rules.recoveryAdjustment} otherwise.`}
      </p>
      <p>
        Earned by {trace.emitterName} from {trace.originLabel}. Lineage{' '}
        <code>{trace.lineageId}</code>.
      </p>
    </>
  );
}
export function MechanicsCard({ state, enabled }: { state: MechanicsState; enabled: boolean }) {
  return (
    <section aria-label="Novel mechanics" className={styles.analysis}>
      <h3>Habitat traces and dormant possibilities</h3>
      <p>
        Only valid observations consume these allowances. Offline, paused and interrupted time
        consumes none.
      </p>
      <section aria-label="Active habitat trace">
        <h4>Active habitat trace</h4>
        {state.activeTrace === null ? (
          <p>No active trace.{!enabled && ' Habitat traces are disabled.'}</p>
        ) : (
          <TraceDetails trace={state.activeTrace} rules={state.traceRules} />
        )}
        <p>
          One shared modifier applies to resident and visitor; net adjustment is capped at{' '}
          {state.traceRules.adjustmentMin} to +{state.traceRules.adjustmentMax}, apart from bounded
          arrival-shock reduction.
        </p>
      </section>
      {state.pendingCount > 0 && (
        <section aria-label="Pending habitat traces">
          <h4>Pending trace offers ({state.pendingCount})</h4>
          <p>
            No effect until chat chooses 1 Keep. 2 Clear or no votes discards the offer; a third
            choice is invalid. Keeping replaces the old trace and begins at the observation
            boundary.
          </p>
          <ul>
            {state.pendingTraces.map((trace) => (
              <li key={trace.id}>
                <TraceDetails trace={trace} rules={state.traceRules} />
              </li>
            ))}
          </ul>
          {state.pendingCount > state.pendingTraces.length && (
            <p>Showing the first {state.pendingTraces.length} offers in qualification order.</p>
          )}
        </section>
      )}
      <section aria-label="Dormant mutations">
        <h4>Dormant possibilities</h4>
        {state.dormant.length === 0 ? (
          <p>No preserved dormant option here.</p>
        ) : (
          <ul>
            {state.dormant.map((dormant) => (
              <li key={dormant.id}>
                A minority in {dormant.originLabel} preserved this possibility for{' '}
                {dormant.organismName}: {dormant.template.to} +{dormant.template.amount},{' '}
                {dormant.template.from} -{dormant.template.amount}. {dormant.supporters} of{' '}
                {dormant.totalVotes} votes · {dormant.remainingRounds} valid observations remaining.
                {dormant.inherited && ' Inherited with its existing allowance.'}{' '}
                {dormant.offered
                  ? 'Its one offer has been used; it cannot be offered again.'
                  : 'May enter one future ballot if known habitat and gene bounds permit.'}{' '}
                It grants no genes, energy or protection until selected as a normal mutation.
              </li>
            ))}
          </ul>
        )}
      </section>
      {state.recentTraces.length > 0 && (
        <details>
          <summary>Recent trace history (up to 8)</summary>
          <ul>
            {state.recentTraces.map((trace) => (
              <li key={trace.id}>
                {trace.template} · {trace.status} · {trace.emitterName} from {trace.originLabel}{' '}
                {trace.choice !== null && `· chat chose ${trace.choice}`}{' '}
                {trace.reason !== null && `· ${trace.reason}`} · no current effect. Lineage{' '}
                <code>{trace.lineageId}</code>.
              </li>
            ))}
          </ul>
        </details>
      )}
    </section>
  );
}
