import { track } from '../realtime/analytics.ts';
import { founderShell, type RoundAnalysis } from '@ripple/contracts';
import { ShellRenderer } from '../studio/ShellRenderer.tsx';
import styles from './Controller.module.css';

type Score = RoundAnalysis['participants'][number]['actual']['score'];
function signed(value: number): string {
  return value >= 0 ? `+${value}` : String(value);
}
function Genes({ score }: { score: Score }) {
  return (
    <p>
      Pulse {score.genome.pulse} · Calm {score.genome.calm} · Grit {score.genome.grit} · Drift{' '}
      {score.genome.drift}
    </p>
  );
}
export function RoundAnalysisCard({
  analysis,
  scope = null,
}: {
  analysis: RoundAnalysis;
  /** When given, opening a saved comparison records an anonymous trial_opened event. */
  scope?: { worldId: string; channelId: string } | null;
}) {
  const opened = (event: React.SyntheticEvent<HTMLDetailsElement>) => {
    if (event.currentTarget.open && scope !== null)
      track('trial_opened', { kind: 'channel', ...scope });
  };
  if (analysis.status === 'cancelled')
    return (
      <section aria-label="Round analysis" className={styles.analysis}>
        <h3>Trace decision cancelled</h3>
        <p>No vote was applied and no observation was scored.</p>
      </section>
    );
  return (
    <section aria-label="Round analysis" className={styles.analysis}>
      <h3>Recorded round analysis</h3>
      <p>{analysis.modelLabel} Shadows and rejected choices change no live energy or lineage.</p>
      {analysis.participants.map(({ organismId, role, actual, ancestor }) => (
        <section key={organismId} aria-label={`${role} comparison`} className={styles.comparison}>
          <div className={styles.actualResult}>
            <h4>Actual result · {role}</h4>
            <Genes score={actual.score} />
            <p>
              Recorded energy {actual.healthBefore} → {actual.healthAfter}.
              {actual.outcome === 'limited'
                ? ' Limited data: energy held; the score below is an estimate.'
                : ' Applied observation score.'}
            </p>
            <p>
              {actual.outcome === 'limited' ? 'Estimated' : 'Recorded'} fitness{' '}
              {actual.score.fitness}; energy change{' '}
              {signed(actual.score.healthAfter - actual.score.healthBefore)}.
            </p>
            <p>{actual.explanation.headline}</p>
            <ul>
              {actual.explanation.causes.map((cause, index) => (
                <li key={index}>{cause.text}</li>
              ))}
            </ul>
            <details onToggle={opened}>
              <summary>Complete recorded calculation</summary>
              <dl>
                {actual.explanation.calculation.map((row, index) => (
                  <div key={index}>
                    <dt>{row.label}</dt>
                    <dd>
                      {row.formula} = {row.value}
                    </dd>
                  </div>
                ))}
              </dl>
              {actual.explanation.contributions.map((row, index) => (
                <p key={index}>
                  {row.text} ({signed(row.amount)})
                </p>
              ))}
              {actual.explanation.notes.map((note, index) => (
                <p key={index}>{note}</p>
              ))}
            </details>
          </div>
          <div className={styles.shadowResult}>
            <h4>Ancestral shadow · model comparison</h4>
            {ancestor === null ? (
              <p>
                {actual.outcome === 'limited'
                  ? 'Insufficient valid data for an ancestor trial.'
                  : 'No ancestor comparison was recorded for this older round.'}
              </p>
            ) : (
              <>
                {!ancestor.result.identicalGenome && (
                  <div className={styles.ancestorOutline} aria-label="Founding ancestor outline">
                    <ShellRenderer part={founderShell} />
                  </div>
                )}
                <Genes score={ancestor.result.ancestor} />
                {ancestor.result.identicalGenome ? (
                  <p>Identical founding genome: genetic contributions are equal.</p>
                ) : (
                  <p>
                    Current minus ancestor: fitness {signed(ancestor.result.fitnessDifference)};
                    scored delta {signed(ancestor.result.deltaDifference)}.
                  </p>
                )}
                <p>
                  Shadow fitness {ancestor.result.ancestor.fitness}; energy change{' '}
                  {signed(
                    ancestor.result.ancestor.healthAfter - ancestor.result.ancestor.healthBefore,
                  )}
                  . Same start energy, profile, raw shocks and trace; gene effects recomputed.
                </p>
                {!ancestor.result.identicalGenome && (
                  <ul>
                    <li>
                      Habitat fit: current {ancestor.result.current.fit}, ancestor{' '}
                      {ancestor.result.ancestor.fit}.
                    </li>
                    <li>
                      Shock after protection: current {ancestor.result.current.shock}, ancestor{' '}
                      {ancestor.result.ancestor.shock}.
                    </li>
                  </ul>
                )}
                <details onToggle={opened}>
                  <summary>Saved comparison identity</summary>
                  <p>
                    Engine {ancestor.engineVersion} · rules <code>{ancestor.rulesHash}</code>
                  </p>
                </details>
              </>
            )}
          </div>
        </section>
      ))}
      {analysis.settlement !== null && (
        <p>
          Scores above precede contest settlement. Outcome: {analysis.settlement.outcome}; Shelter
          moved {analysis.settlement.moved} energy. Settled resident energy{' '}
          {analysis.settlement.residentHealth ?? 'none'}; visitor energy{' '}
          {analysis.settlement.visitorHealth}.
        </p>
      )}
      {analysis.traceAttribution !== null && (
        <p>
          Scored with {analysis.traceAttribution.template} trace from lineage{' '}
          <code>{analysis.traceAttribution.lineageId}</code>, originating in channel{' '}
          <code>{analysis.traceAttribution.originChannelId}</code>. Historical attribution remains
          after expiry.
        </p>
      )}
      {analysis.alternative !== null ? (
        <section className={styles.rejectedResult} aria-label="Rejected choices">
          <h4>Rejected choices · model comparisons</h4>
          <p>
            {analysis.alternative.inputs.selectedId === null
              ? 'Actual choice: Hold.'
              : 'Compared with the recorded selected card.'}{' '}
            {analysis.alternative.confidence === 'limited' &&
              'Limited data: all comparisons are estimates; actual energy was held.'}
          </p>
          <ul>
            {analysis.alternative.result.rejected.map((rejected) => {
              const card = analysis.alternative?.inputs.candidates.find(
                (candidate) => candidate.id === rejected.candidateId,
              );
              return (
                <li key={rejected.candidateId}>
                  <strong>{card?.effect ?? rejected.candidateId}</strong> — {card?.tradeOff}. Model
                  fitness {rejected.score.fitness}; energy change{' '}
                  {signed(rejected.score.healthAfter - rejected.score.healthBefore)}. Compared with{' '}
                  the selected-genome model: fitness {signed(rejected.fitnessDifference)}, energy{' '}
                  {signed(rejected.energyDifference)}.
                </li>
              );
            })}
          </ul>
        </section>
      ) : analysis.kind === 'MUTATION' ? (
        <p>No rejected-choice comparison was recorded for this older round.</p>
      ) : null}
    </section>
  );
}
