import type { PropagationView } from '@ripple/contracts';

export function admissionLabel(outcome: string): string {
  const labels: Record<string, string> = {
    QUEUED: 'Arrival queued',
    PENDING_APPROVAL: 'Waiting for broadcaster approval',
    OFFLINE_HOLD: 'Held while offline or paused',
    GRANT_REVOKED: 'Held until authorization returns',
    INPUT_UNAVAILABLE: 'Held until input recovery',
    RULES_INCOMPATIBLE: 'Held for compatible rules',
    HARBOR: 'Waiting in harbor',
    HARBOR_FULL: 'Harbor full; no child admitted',
    ACTIVE: 'Active visitor',
    DECLINED: 'Declined and archived',
    EXPIRED: 'Admission expired',
    SOURCE_BLOCKED: 'Source blocked',
    LINEAGE_BLOCKED: 'Lineage blocked',
    POLICY_REJECTED: 'Visitors rejected by policy',
    NOT_ENROLLED: 'Destination has not connected Ripple',
    SOURCE_INELIGIBLE: 'No living source resident',
    SOURCE_AUTHORIZATION_REVOKED: 'Source authorization unavailable',
    LINEAGE_CAP: 'Living lineage cap reached',
    GENERATION_CAP: 'Generation limit reached',
    FORK_COOLDOWN: 'Source/destination cooldown',
    SELF_RAID: 'Source and destination are the same',
    VISITOR_WON: 'Visitor became resident',
    VISITOR_LOST: 'Visitor became a fossil',
    BOTH_EXTINCT: 'Both strains became fossils',
    RESIDENT_ESTABLISHED: 'Visitor established in an empty habitat',
  };
  return labels[outcome] ?? outcome;
}
export function PropagationCard({ view }: { view: PropagationView }) {
  const visitor = view.visitor,
    contest = view.lastContest;
  return (
    <section aria-label="Raids and lineage">
      <h3>Raids and lineage</h3>
      <p>
        Standing travel choice: {view.preparation}.{' '}
        {view.preparationRequested
          ? 'Preparation ballot queued for a safe boundary.'
          : 'The next raid uses the last committed choice.'}
      </p>
      {view.resident !== null && (
        <p>
          Resident origin: {view.resident.originLabel} · Generation {view.resident.generation}/
          {view.limits.generationCap} · Living branches {view.resident.livingBranches}/
          {view.limits.livingLineageCap}
        </p>
      )}
      {visitor === null ? (
        <p>No active visitor.</p>
      ) : (
        <section aria-label="Active visitor">
          <h4>{visitor.name} — visitor</h4>
          <p>
            Energy {visitor.health}/100 · Origin {visitor.originLabel} · Generation{' '}
            {visitor.generation}/{view.limits.generationCap}
          </p>
          <p>
            {visitor.welcomed
              ? 'Welcome complete.'
              : 'Welcome waits for the current ballot to finish.'}{' '}
            {visitor.arrivalPending
              ? `Arrival protection: ${visitor.shockReduction} less raw shock on the first valid observation.`
              : 'Arrival pressure resolved.'}
          </p>
          {visitor.shelterPending && (
            <p>
              Shelter is pending one valid observation. Limited or interrupted observations keep it
              pending.
            </p>
          )}
          <p>
            Living branches {visitor.livingBranches}/{view.limits.livingLineageCap}, including held
            arrivals.
          </p>
        </section>
      )}
      <p>
        Waiting arrivals: {view.admissions.filter((t) => t.outcome !== 'ACTIVE').length}/
        {view.limits.harborCap}. Waiting arrivals do not lose energy.
      </p>
      {view.admissions.length > 0 && (
        <ul>
          {view.admissions.map((t) => (
            <li key={t.id}>
              From {t.sourceLabel}: {admissionLabel(t.outcome)}
              {t.outcome !== 'ACTIVE' && t.expiresAt !== null
                ? ` · Expires ${new Date(t.expiresAt).toLocaleString()}`
                : ''}
            </li>
          ))}
        </ul>
      )}
      {contest !== null && (
        <p role="note">
          Last comparison:{' '}
          {contest.outcome === 'sheltered'
            ? `Shelter moved ${contest.moved} energy from resident to visitor; the contest was deferred once.`
            : contest.outcome === 'held'
              ? 'Confidence was limited. Energy, protection and the contest remain held.'
              : contest.outcome === 'visitor'
                ? 'The visitor became resident; the former resident is a fossil.'
                : contest.outcome === 'resident'
                  ? 'The resident stayed; the visitor is a fossil.'
                  : 'Both strains became fossils.'}{' '}
          Resident energy {contest.residentHealth ?? 'none'} · Visitor energy{' '}
          {contest.visitorHealth}.
        </p>
      )}
      {view.outgoing.length > 0 && (
        <details>
          <summary>Recent outgoing raids</summary>
          <ul>
            {view.outgoing.map((t) => (
              <li key={t.id}>
                {t.destinationLabel ?? 'Unenrolled destination'}: {admissionLabel(t.outcome)}
              </li>
            ))}
          </ul>
        </details>
      )}
    </section>
  );
}
