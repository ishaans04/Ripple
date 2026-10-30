import { useCallback, useEffect, useRef, useState } from 'react';
import type { AppearanceBlueprint, ArtistStatus, StudioState } from '@ripple/contracts';
import { ShellRenderer } from './ShellRenderer.tsx';
import { StudioEditor, templateNames } from './Studio.tsx';
import {
  StudioRequestError,
  fetchArtist,
  fetchStudio,
  proposalMessages,
  submitProposal,
  withdrawProposal,
} from './studioApi.ts';
import styles from './Studio.module.css';

const RETURN_KEY = 'ripple:studio-session';
const phaseText: Record<string, string> = {
  OPENING: 'Opening the studio…',
  CREATING: 'Creation is open. Shape a shell and submit one proposal.',
  VOTING: 'Creation has closed. Chat is choosing a design.',
  REVIEW: 'Chat chose a design. The broadcaster is reviewing it.',
  PENDING_HATCH: 'Community design selected. Hatches after the current round.',
  COMPLETED: 'This studio is complete.',
  CANCELLED: 'This studio was closed without a new design.',
  EXPIRED: 'This studio expired without a new design.',
};
const outcomeText: Record<string, string> = {
  keep_current: 'The community kept the current shell.',
  hatched: 'The community design hatched.',
  host_returned: 'The broadcaster returned before creation closed; no draft was applied.',
  host_returned_during_voting:
    'The broadcaster returned and cancelled the vote; no result was applied.',
  stream_offline: 'The stream went offline, so creation and voting closed without a result.',
  chat_unavailable: 'Chat input was unavailable when creation closed, so no vote was held.',
  review_expired: 'The review window ended before a decision; nothing changed.',
  broadcaster_kept_current: 'The broadcaster kept the current shell.',
  broadcaster_released: 'The broadcaster released the pending design; nothing changed.',
  organism_fossilized: 'The creature became a fossil, so the design was cancelled.',
  BASE_STATE_CHANGED:
    'The creature changed, so the design could not be applied at its original cost.',
};

function countdown(target: number | null, offset: number, now: number): string | null {
  if (target === null) return null;
  const seconds = Math.max(0, Math.ceil((target - (now + offset)) / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

export function LiveStudio({ sessionId }: { sessionId: string }) {
  const [state, setState] = useState<StudioState | null>(null);
  const [offset, setOffset] = useState(0);
  const [offline, setOffline] = useState(false);
  const [missing, setMissing] = useState(false);
  const [artist, setArtist] = useState<ArtistStatus | null>(null);
  const [operation, setOperation] = useState<string | null>(null);
  const [message, setMessage] = useState('');
  const [retry, setRetry] = useState<{
    blueprint: AppearanceBlueprint;
    creditOptIn: boolean;
  } | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const attempt = useRef<{ key: string; proposalId: string; body: string } | null>(null);

  useEffect(() => {
    sessionStorage.setItem(RETURN_KEY, sessionId);
    const controller = new AbortController();
    let timer: number | undefined;
    const load = async () => {
      try {
        const next = await fetchStudio(sessionId, controller.signal);
        setState(next);
        setOffset(next.serverTimeMs - Date.now());
        setOffline(false);
      } catch (error) {
        if (controller.signal.aborted) return;
        if (error instanceof StudioRequestError && error.code === 'STUDIO_NOT_FOUND')
          setMissing(true);
        // A lost connection keeps the last state and the local draft; it retries quietly.
        else setOffline(true);
      }
      timer = window.setTimeout(() => void load(), 2000);
    };
    void load();
    return () => {
      controller.abort();
      window.clearTimeout(timer);
    };
  }, [sessionId]);
  useEffect(() => {
    const tick = window.setInterval(() => {
      setNow(Date.now());
    }, 1000);
    return () => {
      window.clearInterval(tick);
    };
  }, []);
  const refreshArtist = useCallback(async () => {
    try {
      const next = await fetchArtist(sessionId, operation);
      setArtist(next);
      if (next.lastResult !== null && next.lastResult.operationId === operation) {
        setMessage(
          proposalMessages[next.lastResult.code] ?? `Not accepted (${next.lastResult.code}).`,
        );
        setOperation(null);
        if (next.lastResult.code === 'APPLIED') attempt.current = null;
      }
    } catch {
      /* Artist status is advisory; the studio state still loads. */
    }
  }, [operation, sessionId]);
  useEffect(() => {
    const first = window.setTimeout(() => void refreshArtist(), 0);
    const timer = window.setInterval(() => void refreshArtist(), operation === null ? 5000 : 1000);
    return () => {
      window.clearTimeout(first);
      window.clearInterval(timer);
    };
  }, [operation, refreshArtist]);

  const session = state?.studio.session ?? null;
  const creating = session?.phase === 'CREATING' && state?.challenge !== null;
  const send = useCallback(
    (blueprint: AppearanceBlueprint, creditOptIn: boolean) => {
      if (artist?.signedIn !== true || artist.csrfToken === null) {
        setMessage(proposalMessages.ARTIST_SIGN_IN_REQUIRED ?? '');
        return;
      }
      const body = JSON.stringify({ blueprint, creditOptIn });
      // A retried identical submission keeps its key, so a lost response cannot duplicate it.
      if (attempt.current?.body !== body)
        attempt.current = { key: crypto.randomUUID(), proposalId: crypto.randomUUID(), body };
      const current = attempt.current;
      setMessage('Submitting…');
      submitProposal({
        sessionId,
        csrfToken: artist.csrfToken,
        key: current.key,
        proposalId: current.proposalId,
        blueprint,
        creditOptIn,
      })
        .then(() => {
          setRetry(null);
          setOperation(current.key);
        })
        .catch((error: unknown) => {
          const code = error instanceof StudioRequestError ? error.code : 'NETWORK_ERROR';
          if (code === 'NETWORK_ERROR') setRetry({ blueprint, creditOptIn });
          setMessage(proposalMessages[code] ?? `Not accepted (${code}).`);
        });
    },
    [artist, sessionId],
  );
  if (missing)
    return (
      <main className={styles.page}>
        <h1>This studio link is unavailable.</h1>
        <p>
          It may have expired. You can still <a href="/studio">practice locally</a>.
        </p>
      </main>
    );
  if (state === null)
    return (
      <main className={styles.page}>
        <p role="status">Opening Cocoon Studio…</p>
      </main>
    );
  if (state.challenge === null || session === null)
    return (
      <main className={styles.page}>
        <h1>This studio has ended.</h1>
        <p>
          {state.label} has moved on. You can still <a href="/studio">practice locally</a>.
        </p>
      </main>
    );
  const active = artist?.proposals.find((proposal) => proposal.status === 'active');
  const remaining = countdown(
    session.phase === 'CREATING'
      ? session.creationCloseAtMs
      : session.phase === 'VOTING'
        ? session.votingCloseAtMs
        : session.phase === 'REVIEW'
          ? session.reviewExpiresAtMs
          : null,
    offset,
    now,
  );
  const status = (
    <div className={styles.liveStatus}>
      {offline && (
        <p role="alert">Connection lost. Your draft is kept on this device; reconnecting…</p>
      )}
      <div className={styles.creature}>
        {state.organism !== null && (
          <ShellRenderer
            part={
              state.organism.appearance.kind === 'studio'
                ? state.organism.appearance.blueprint.part
                : state.organism.appearance.part
            }
            label={`${state.organism.name}, current shell`}
          />
        )}
        <div>
          <p className={styles.eyebrow}>{state.label}</p>
          <h2>{state.organism?.name ?? 'Current creature'}</h2>
          {state.organism !== null && (
            <p className={styles.muted}>
              Pulse {state.organism.genome.pulse} · Calm {state.organism.genome.calm} · Grit{' '}
              {state.organism.genome.grit} · Drift {state.organism.genome.drift}
            </p>
          )}
        </div>
      </div>
      <p role="status" aria-live="polite">
        <strong>{phaseText[session.phase]}</strong>
        {remaining !== null && <> Time remaining: {remaining}.</>}
      </p>
      {session.outcome !== null && (
        <p>{outcomeText[session.outcome.reason] ?? `Ended: ${session.outcome.reason}.`}</p>
      )}
      <p>
        Trade-offs on offer: {session.challenge.templates.map((id) => templateNames[id]).join('; ')}
        .
        {session.cosmeticOnly &&
          ' No legal shell mutation exists now, so designs are appearance only.'}
      </p>
      <details>
        <summary>Submission rules</summary>
        <ul>
          <li>One active proposal per artist; you may replace it before creation closes.</li>
          <li>
            {session.accepted} of {session.maxProposals} proposals accepted so far.
          </li>
          <li>
            At most two finalists are chosen by a recorded seeded draw that prefers different
            trade-offs; hand and pointer designs are treated identically.
          </li>
          <li>Chat votes with !ripple 1, 2 or 3. Keep current is always offered and wins ties.</li>
          <li>Submitting needs a Twitch sign-in; voting never does.</li>
        </ul>
      </details>
      {session.phase === 'VOTING' && (
        <ol className={styles.finalists} aria-label="Finalists">
          {session.finalists.map((finalist) => (
            <li key={finalist.hash}>
              <ShellRenderer part={finalist.blueprint.part} label={`Design ${finalist.index}`} />
              <span>
                !ripple {finalist.index} · {templateNames[finalist.template]} · by {finalist.credit}{' '}
                · {session.counts[finalist.index - 1] ?? 0} votes
              </span>
            </li>
          ))}
          <li>
            !ripple {session.finalists.length + 1} · Keep current ·{' '}
            {session.counts[session.finalists.length] ?? 0} votes
          </li>
        </ol>
      )}
      {session.pending !== null && (
        <div className={styles.cocoon}>
          <ShellRenderer part={session.pending.blueprint.part} label="Pending community design" />
          <p>
            {session.pending.message} Its trade-off ({templateNames[session.pending.template]}) has
            not been applied yet.
          </p>
        </div>
      )}
      {artist?.available === false ? (
        <p className={styles.muted}>
          Proposal sign-in is not available on this installation. You can still shape and download a
          design here.
        </p>
      ) : artist?.signedIn === true ? (
        <p className={styles.muted}>
          Signed in as {artist.login}.{' '}
          {active !== undefined && (
            <>
              Your proposal (revision {active.revision}) is in.{' '}
              {creating && artist.csrfToken !== null && (
                <button
                  onClick={() => {
                    if (artist.csrfToken === null) return;
                    const key = crypto.randomUUID();
                    withdrawProposal({
                      sessionId,
                      proposalId: active.id,
                      csrfToken: artist.csrfToken,
                      key,
                    })
                      .then(() => {
                        setMessage('Withdrawal requested.');
                        setOperation(key);
                      })
                      .catch((error: unknown) => {
                        setMessage(
                          proposalMessages[
                            error instanceof StudioRequestError ? error.code : 'NETWORK_ERROR'
                          ] ?? 'Withdrawal failed.',
                        );
                      });
                  }}
                >
                  Withdraw it
                </button>
              )}
            </>
          )}
        </p>
      ) : (
        creating && (
          <p>
            <a className={styles.primary} href="/auth/twitch/artist/start">
              Sign in with Twitch to submit
            </a>{' '}
            <span className={styles.muted}>Identity only: no channel, chat or payment access.</span>
          </p>
        )
      )}
      {message !== '' && <p role="status">{message}</p>}
      {retry !== null && creating && (
        <button
          onClick={() => {
            send(retry.blueprint, retry.creditOptIn);
          }}
        >
          Retry submission
        </button>
      )}
    </div>
  );
  return (
    <StudioEditor
      key={state.challenge.studioSessionId}
      challenge={state.challenge}
      live={{
        status,
        canSubmit: creating && artist?.signedIn === true && !offline,
        cameraAvailable: creating,
        submit: send,
      }}
    />
  );
}
