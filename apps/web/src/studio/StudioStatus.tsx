import type { ChannelView, StudioMutationTemplate, StudioView } from '@ripple/contracts';
import { ShellRenderer } from './ShellRenderer.tsx';

export const studioTemplateText: Record<StudioMutationTemplate, string> = {
  'grit-plus2-pulse-minus2': 'Grit +2 · Pulse −2',
  'grit-plus2-calm-minus2': 'Grit +2 · Calm −2',
  'grit-plus2-drift-minus2': 'Grit +2 · Drift −2',
  'cosmetic-only': 'Appearance only · genes unchanged',
};
export const studioOutcomeText: Readonly<Record<string, string>> = {
  keep_current: 'The community kept the current shell.',
  hatched: 'The community design hatched.',
  host_returned: 'Studio closed when the broadcaster returned; no draft was applied.',
  host_returned_during_voting: 'Studio vote cancelled on return; no result was applied.',
  stream_offline: 'Stream went offline; the studio closed without a result.',
  chat_unavailable: 'Chat input was unavailable; the studio expired without a vote.',
  review_expired: 'Review window ended; nothing changed.',
  broadcaster_kept_current: 'The broadcaster kept the current shell.',
  broadcaster_released: 'The pending design was released; nothing changed.',
  organism_fossilized: 'The creature became a fossil; the design was cancelled.',
};

function clock(target: number | null, now: number): string | null {
  if (target === null) return null;
  const seconds = Math.max(0, Math.ceil((target - now) / 1000));
  return `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
}

/** True while a studio, rather than the ordinary round, owns the channel's decision. */
export function studioHoldsDecision(studio: StudioView | undefined): boolean {
  const phase = studio?.session?.phase;
  return phase === 'OPENING' || phase === 'CREATING' || phase === 'VOTING' || phase === 'REVIEW';
}

/**
 * Public studio presentation: only finalists, pending and committed designs are shown, and a
 * pending design is always labelled as not yet applied.
 */
export function StudioStatus({
  channel,
  now,
  showLink,
  syntheticControls = false,
}: {
  channel: ChannelView;
  now: number;
  showLink: boolean;
  syntheticControls?: boolean;
}) {
  const session = channel.studio?.session;
  const hatch = channel.round?.studioHatch;
  if (
    hatch !== undefined &&
    channel.round?.phase === 'VOTING' &&
    session?.pending !== null &&
    session?.pending !== undefined
  )
    return (
      <section aria-label="Cocoon Studio hatch">
        <h2>Community design hatching</h2>
        <ShellRenderer part={session.pending.blueprint.part} label="Incubating community design" />
        <p>
          {studioTemplateText[session.pending.template]} · by {session.pending.credit}. It hatches
          when this slot closes
          {clock(channel.round.voteCloseAtMs, now) === null
            ? '.'
            : ` in ${clock(channel.round.voteCloseAtMs, now) ?? ''}.`}{' '}
          No ballot this round.
        </p>
      </section>
    );
  if (session === undefined || session === null) return null;
  switch (session.phase) {
    case 'OPENING':
    case 'CREATING':
      return (
        <section aria-label="Cocoon Studio">
          <h2>Cocoon Studio is open</h2>
          <p>
            Shape a shell by hand or pointer
            {showLink && (
              <>
                {' '}
                at <strong>{`${window.location.origin}/studio?s=${session.id}`}</strong>
              </>
            )}
            . Camera optional and stays in your browser.
          </p>
          <p>
            Trade-offs: {session.challenge.templates.map((id) => studioTemplateText[id]).join('; ')}
            {session.cosmeticOnly && ' · appearance only, no game power'}
          </p>
          <p>
            {session.accepted} proposals · creation closes in{' '}
            {clock(session.creationCloseAtMs, now) ?? '—'} · game paused at its checkpoint
          </p>
        </section>
      );
    case 'VOTING': {
      const votes = session.counts.reduce((sum, count) => sum + count, 0);
      return (
        <section aria-label="Cocoon Studio vote">
          <h2>Choose the community shell</h2>
          <ol aria-label="Studio finalists">
            {session.finalists.map((finalist) => (
              <li key={finalist.hash}>
                <ShellRenderer part={finalist.blueprint.part} label={`Design ${finalist.index}`} />
                <strong>
                  {finalist.index}. {studioTemplateText[finalist.template]}
                </strong>{' '}
                · by {finalist.credit} · {session.counts[finalist.index - 1] ?? 0} votes
              </li>
            ))}
            <li>
              <strong>{session.finalists.length + 1}. Keep current</strong> ·{' '}
              {session.counts[session.finalists.length] ?? 0} votes
            </li>
          </ol>
          <p>
            {syntheticControls ? 'Use Synthetic vote above: ' : 'Vote in chat: '}
            {session.finalists
              .map((f) => (syntheticControls ? String(f.index) : `!ripple ${f.index}`))
              .join(', ')}{' '}
            or {syntheticControls ? '' : '!ripple '}
            {session.finalists.length + 1} · closes in {clock(session.votingCloseAtMs, now) ?? '—'}{' '}
            · {votes} votes
          </p>
          <p>No votes or a tie with Keep current keeps the current shell.</p>
        </section>
      );
    }
    case 'REVIEW':
      return (
        <section aria-label="Cocoon Studio review">
          <h2>Community design chosen</h2>
          <p>
            Design {session.selection?.finalistIndex ?? ''} won the vote and awaits broadcaster
            review. Nothing has changed yet.
          </p>
        </section>
      );
    case 'PENDING_HATCH':
      return session.pending === null ? null : (
        <section aria-label="Pending community design">
          <ShellRenderer part={session.pending.blueprint.part} label="Pending community design" />
          <p>{session.pending.message} Health, protection and genes are unchanged until then.</p>
        </section>
      );
    case 'COMPLETED':
    case 'CANCELLED':
    case 'EXPIRED':
      return session.outcome === null ? null : (
        <p>{studioOutcomeText[session.outcome.reason] ?? 'Cocoon Studio ended.'}</p>
      );
  }
}
