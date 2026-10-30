import { useEffect, useState } from 'react';
import { z } from 'zod';
import type { ChannelView, StudioState } from '@ripple/contracts';
import { ChannelCard } from '../controller/ChannelCard.tsx';
import { StudioEditor } from '../studio/Studio.tsx';
import { StudioStatus } from '../studio/StudioStatus.tsx';
import { track } from '../realtime/analytics.ts';
import {
  judgeFromHash,
  judgeSchema,
  readFragment,
  sandboxRequest,
  saveJudge,
  snapshot,
  studioState,
  type Judge,
} from './api.ts';
import styles from './Sandbox.module.css';

const replaySchema = z.object({
  replayWorldId: z.uuid(),
  sourceComparison: z.array(z.object({ equal: z.boolean() })).nullable(),
  channels: z.array(
    z.object({
      channelId: z.uuid(),
      label: z.string(),
      records: z.number(),
      readCapability: z.string(),
    }),
  ),
});
type Replay = z.infer<typeof replaySchema>;

export default function Sandbox() {
  const [judge, setJudge] = useState<Judge | null>(() => judgeFromHash(location.hash));
  const [selected, setSelected] = useState<string | null>(null);
  const [channel, setChannel] = useState<ChannelView | null>(null);
  const [studio, setStudio] = useState<StudioState | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [replay, setReplay] = useState<Replay | null>(null);
  const channelId = selected ?? judge?.channelId;
  useEffect(() => {
    const changed = () => {
      setJudge(judgeFromHash(location.hash));
      setSelected(null);
      setChannel(null);
      setStudio(null);
      setMessage('');
      setReplay(null);
    };
    window.addEventListener('hashchange', changed);
    return () => {
      window.removeEventListener('hashchange', changed);
    };
  }, []);
  async function refresh(current: Judge, id: string) {
    const next = await snapshot(current, id);
    setChannel(next);
    setStudio(next.studio?.session ? await studioState(next.studio.session.id) : null);
  }
  useEffect(() => {
    if (!judge || !channelId) return;
    let stopped = false;
    const load = async () => {
      try {
        const next = await snapshot(judge, channelId);
        const session = next.studio?.session;
        const nextStudio = session ? await studioState(session.id) : null;
        if (!stopped) {
          setChannel(next);
          setStudio(nextStudio);
        }
      } catch (error) {
        if (!stopped) setMessage(error instanceof Error ? error.message : 'Could not refresh.');
      }
    };
    void load();
    const timer = window.setInterval(() => void load(), 3000);
    return () => {
      stopped = true;
      window.clearInterval(timer);
    };
  }, [judge, channelId]);
  async function run(work: () => Promise<void>) {
    setBusy(true);
    setMessage('');
    try {
      await work();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Request failed.');
    } finally {
      setBusy(false);
    }
  }
  function create(reset = false) {
    void run(async () => {
      const next = judgeSchema.parse(
        await sandboxRequest(
          reset && judge ? `/api/sandbox/${judge.worldId}/reset` : '/api/sandbox',
          judge ?? undefined,
        ),
      );
      saveJudge(next);
      setSelected(null);
      setChannel(null);
      setStudio(null);
      setReplay(null);
      setJudge(next);
      await refresh(next, next.channelId);
      setMessage('Your independent synthetic world is ready. Choose a mutation below.');
    });
  }
  async function action(body: Record<string, unknown>) {
    if (!judge || !channelId) return;
    const result = await sandboxRequest(`/api/sandbox/${judge.worldId}/actions`, judge, {
      channelId,
      ...body,
    });
    const effects = z.object({ results: z.array(z.unknown()) }).parse(result).results;
    const codes = effects
      .map((effect) => z.object({ code: z.string() }).safeParse(effect))
      .filter((effect) => effect.success)
      .map((effect) => effect.data.code);
    await refresh(judge, channelId);
    setMessage(
      codes.length
        ? `Synthetic ${String(body.action)}: ${codes.join(', ')}.`
        : 'Synthetic clock advanced to the next scheduled step.',
    );
  }
  const button = (label: string, body: Record<string, unknown>) => (
    <button disabled={busy} onClick={() => void run(() => action(body))}>
      {label}
    </button>
  );
  const phase = channel?.studio?.session?.phase;
  useEffect(() => {
    const session = studio?.challenge?.studioSessionId;
    if (session) track('editor_opened', { kind: 'studio', sessionId: session });
  }, [studio?.challenge?.studioSessionId]);
  return (
    <div className={styles.page}>
      <main>
        <a href="/">Ripple</a>
        <p className={styles.badge}>Synthetic sandbox · isolated world · accelerated clock</p>
        <h1>Your three-minute expedition</h1>
        <p>
          No account needed. Every action here is simulated. Time advances only when you choose Next
          scheduled step; your world expires after 24 hours.
        </p>
        <ol>
          <li>
            Choose a mutation, advance to observation, add chat or a habitat change, then advance to
            the result.
          </li>
          <li>
            Simulate a raid, switch to the neighbor and advance to its welcome vote. Inspect the
            contest, dormant choices, traces and ancestor comparison in the round details.
          </li>
          <li>
            Switch home, advance to its next ballot, start a break, shape a proposal by hand or
            pointer and confirm submission.
          </li>
          <li>
            Advance to studio voting, vote for a design, advance to review and approve. Advance
            through observation and the next mutation slot to hatch.
          </li>
          <li>
            Inspect the passport and lineage, replay the accepted history, then reset for a fresh
            world.
          </li>
        </ol>
        {!judge ? (
          <button
            disabled={busy}
            onClick={() => {
              create();
            }}
          >
            Start my sandbox
          </button>
        ) : (
          <>
            <nav className={styles.controls} aria-label="Synthetic channels">
              <button
                disabled={busy}
                aria-pressed={channelId === judge.channelId}
                onClick={() => {
                  setChannel(null);
                  setSelected(judge.channelId);
                }}
              >
                Home channel
              </button>
              <button
                disabled={busy}
                aria-pressed={channelId === judge.neighborId}
                onClick={() => {
                  setChannel(null);
                  setSelected(judge.neighborId);
                }}
              >
                Neighbor channel
              </button>
              <button
                disabled={busy}
                onClick={() => {
                  create(true);
                }}
              >
                Reset sandbox
              </button>
            </nav>
            <section aria-label="Synthetic controls" className={styles.controls}>
              {button('Next scheduled step', { action: 'next' })}
              {button('Add local chat', { action: 'chat', accounts: 3 })}
              {button('Change habitat', { action: 'shock' })}
              {button('Prepare for travel', { action: 'prepare' })}
              {button('Simulate raid to other channel', {
                action: 'raid',
                destinationId: channelId === judge.channelId ? judge.neighborId : judge.channelId,
              })}
              {button('Pause', { action: 'pause' })}
              {button('Resume', { action: 'resume' })}
            </section>
            <section aria-label="Synthetic votes" className={styles.controls}>
              <p>
                One synthetic judge plus three simulated accounts. Choices follow the displayed
                ballot.
              </p>
              {[1, 2, 3].map((choice) => (
                <button
                  key={choice}
                  disabled={busy}
                  onClick={() => void run(() => action({ action: 'vote', choice, crowd: true }))}
                >
                  Synthetic vote {choice}
                </button>
              ))}
            </section>
            <section aria-label="Synthetic studio controls" className={styles.controls}>
              {button('Start break studio', { action: 'studioStart' })}
              {button('End break', { action: 'studioStop' })}
              {phase === 'REVIEW' && (
                <>
                  {button('Approve design', { action: 'review', decision: 'approve' })}
                  {button('Keep current design', { action: 'review', decision: 'keep' })}
                </>
              )}
            </section>
            <p role="status" aria-live="polite">
              {busy ? 'Applying synthetic action…' : message}
            </p>
            {channel && (
              <>
                <ChannelCard channel={channel} worldId={judge.worldId} />
                <StudioStatus
                  channel={channel}
                  now={studio?.serverTimeMs ?? Date.now()}
                  showLink={false}
                  syntheticControls
                />
              </>
            )}
            {channelId && (
              <p>
                <a href={`/preview${readFragment(judge, channelId)}`}>Inspect round details</a> ·{' '}
                <a href={`/lineage${readFragment(judge, channelId)}`}>Lineage and passports</a>
              </p>
            )}
            <section aria-label="Replay accepted history">
              <h2>Replay this expedition</h2>
              <button
                disabled={busy}
                onClick={() =>
                  void run(async () => {
                    const report = replaySchema.parse(
                      await sandboxRequest(`/api/sandbox/${judge.worldId}/replay`, judge),
                    );
                    setReplay(report);
                    setMessage(
                      report.sourceComparison?.every((entry) => entry.equal)
                        ? 'Replay verified: all channel game state and studio appearance match.'
                        : 'Replay comparison failed. Inspect the report before continuing.',
                    );
                  })
                }
              >
                Replay and verify
              </button>
              {replay && (
                <ul>
                  {replay.channels.map((item) => (
                    <li key={item.channelId}>
                      <a
                        href={`/preview#${new URLSearchParams({ worldId: replay.replayWorldId, channelId: item.channelId, capability: item.readCapability }).toString()}`}
                      >
                        {item.label}: inspect replay ({item.records} accepted records)
                      </a>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          </>
        )}
        {!judge && <p role="status">{message}</p>}
      </main>
      {judge && studio?.challenge && phase === 'CREATING' && (
        <StudioEditor
          key={studio.challenge.studioSessionId}
          challenge={studio.challenge}
          live={{
            mode: 'sandbox',
            status: (
              <p>
                Synthetic proposal for this isolated expedition. No Twitch sign-in needed.
                Submission uses the same validation and hatch rules.
              </p>
            ),
            canSubmit: !busy,
            cameraAvailable: true,
            onEvent: (event) => {
              if (studio.challenge)
                track(event, { kind: 'studio', sessionId: studio.challenge.studioSessionId });
            },
            submit: (blueprint, creditOptIn, inputMode) =>
              void run(() => action({ action: 'propose', blueprint, creditOptIn, inputMode })),
          }}
        />
      )}
    </div>
  );
}
