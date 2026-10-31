import { useEffect, useState } from 'react';
import { z } from 'zod';
import type { ChannelView, StudioState } from '@ripple/contracts';
import { ChannelCard } from '../controller/ChannelCard.tsx';
import { StudioEditor } from '../studio/Studio.tsx';
import { StudioStatus } from '../studio/StudioStatus.tsx';
import { track } from '../realtime/analytics.ts';
import { ConsoleSection, ConsoleShell } from '../console/ConsoleShell.tsx';
import {
  milestoneFor,
  sandboxGuide,
  sandboxTour,
  type SandboxMilestone,
} from '../console/guide.ts';
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

const milestoneKey = (worldId: string) => `ripple:sandbox:${worldId}:milestones`;
const milestoneSchema = z.array(
  z.enum(['voted', 'observed', 'raided', 'proposed', 'approved', 'replayed']),
);

/** Milestones are this tab's record of what the visitor actually did in one world. */
function loadMilestones(judge: Judge | null): Set<SandboxMilestone> {
  if (judge === null) return new Set();
  try {
    const parsed = milestoneSchema.safeParse(
      JSON.parse(sessionStorage.getItem(milestoneKey(judge.worldId)) ?? '[]'),
    );
    return new Set(parsed.success ? parsed.data : []);
  } catch {
    return new Set();
  }
}

export default function Sandbox() {
  const [judge, setJudge] = useState<Judge | null>(() => judgeFromHash(location.hash));
  const [selected, setSelected] = useState<string | null>(null);
  const [channel, setChannel] = useState<ChannelView | null>(null);
  const [studio, setStudio] = useState<StudioState | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [replay, setReplay] = useState<Replay | null>(null);
  const [milestones, setMilestones] = useState(() => loadMilestones(judge));
  const channelId = selected ?? judge?.channelId;
  useEffect(() => {
    const changed = () => {
      const next = judgeFromHash(location.hash);
      setJudge(next);
      setMilestones(loadMilestones(next));
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
  function reach(world: Judge, milestone: SandboxMilestone | null) {
    if (milestone === null) return;
    setMilestones((current) => {
      if (current.has(milestone)) return current;
      const next = new Set(current).add(milestone);
      try {
        sessionStorage.setItem(milestoneKey(world.worldId), JSON.stringify([...next]));
      } catch {
        /* Progress is still shown for this page view. */
      }
      return next;
    });
  }
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
      setMilestones(loadMilestones(next));
      await refresh(next, next.channelId);
      setMessage('Your independent synthetic world is ready. Choose a mutation below.');
    });
  }
  async function action(body: Record<string, unknown>) {
    if (!judge || !channelId) return;
    const before = channel;
    const result = await sandboxRequest(`/api/sandbox/${judge.worldId}/actions`, judge, {
      channelId,
      ...body,
    });
    const effects = z.object({ results: z.array(z.unknown()) }).parse(result).results;
    const codes = effects
      .map((effect) => z.object({ code: z.string() }).safeParse(effect))
      .filter((effect) => effect.success)
      .map((effect) => effect.data.code);
    if (body.action !== 'review' || body.decision === 'approve')
      reach(judge, milestoneFor(String(body.action), before));
    await refresh(judge, channelId);
    setMessage(
      codes.length
        ? `Synthetic ${String(body.action)}: ${codes.join(', ')}.`
        : 'Synthetic clock advanced to the next scheduled step.',
    );
  }
  const button = (label: string, body: Record<string, unknown>, emphasis?: boolean) => (
    <button
      className={emphasis === true ? styles.emphasis : undefined}
      disabled={busy}
      onClick={() => void run(() => action(body))}
    >
      {label}
    </button>
  );
  const phase = channel?.studio?.session?.phase;
  useEffect(() => {
    const session = studio?.challenge?.studioSessionId;
    if (session) track('editor_opened', { kind: 'studio', sessionId: session });
  }, [studio?.challenge?.studioSessionId]);
  const onNeighbor = judge !== null && channelId === judge.neighborId;
  return (
    <ConsoleShell
      label="Synthetic sandbox"
      storageKey="sandbox"
      steps={sandboxGuide(judge !== null, milestones, channel?.round?.phase ?? null)}
      tour={sandboxTour}
      welcome="This is a private practice world: no account, no Twitch, nothing public. The rail tracks seven chapters as you actually complete them, and Up next always says which button to press."
      extraNext={
        <p>
          Expedition complete. Reset the sandbox for a fresh world, or open the{' '}
          <a href="/controller">console</a> to play with your real channel.
        </p>
      }
      links={[
        { href: '/', label: 'Home' },
        { href: '/controller', label: 'Console' },
        { href: '/studio', label: 'Studio practice' },
        { href: '/privacy', label: 'Privacy' },
      ]}
    >
      <main className={styles.page}>
        <header className={styles.top}>
          <p className={styles.badge}>Synthetic sandbox · isolated world · accelerated clock</p>
          <h1 className={styles.title}>Your three-minute expedition</h1>
          <p className={styles.lead}>
            No account needed. Every action here is simulated. Time advances only when you choose
            Next scheduled step; your world expires after 24 hours.
          </p>
          {!judge && <p role="status">{message}</p>}
          {judge && (
            <p role="status" aria-live="polite" className={styles.message}>
              {busy ? 'Applying synthetic action…' : message}
            </p>
          )}
        </header>

        <ConsoleSection
          id="expedition"
          index="01"
          title="Your world"
          lead="Two synthetic channels, home and a neighbor, in a world only you can see."
        >
          <ol className={styles.route}>
            <li>
              Choose a mutation, advance to observation, add chat or a habitat change, then advance
              to the result.
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
              className={styles.start}
              disabled={busy}
              onClick={() => {
                create();
              }}
            >
              Start my sandbox
            </button>
          ) : (
            <nav className={styles.channels} aria-label="Synthetic channels">
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
          )}
        </ConsoleSection>

        {judge && (
          <>
            <ConsoleSection
              id="controls"
              index="02"
              title="Clock, chat and raids"
              lead={`You are on the ${onNeighbor ? 'neighbor' : 'home'} channel. Nothing moves until you advance the clock.`}
            >
              <section aria-label="Synthetic controls" className={styles.controls}>
                {button('Next scheduled step', { action: 'next' }, true)}
                {button('Add local chat', { action: 'chat', accounts: 3 })}
                {button('Change habitat', { action: 'shock' })}
                {button('Prepare for travel', { action: 'prepare' })}
                {button('Simulate raid to other channel', {
                  action: 'raid',
                  destinationId: onNeighbor ? judge.channelId : judge.neighborId,
                })}
                {button('Pause', { action: 'pause' })}
                {button('Resume', { action: 'resume' })}
              </section>
              <section id="votes" aria-label="Synthetic votes" className={styles.controls}>
                <p>
                  One synthetic judge plus three simulated accounts. Choices follow the displayed
                  ballot.
                </p>
                {[1, 2, 3].map((choice) => (
                  <button
                    key={choice}
                    className={styles.vote}
                    disabled={busy}
                    onClick={() => void run(() => action({ action: 'vote', choice, crowd: true }))}
                  >
                    Synthetic vote {choice}
                  </button>
                ))}
              </section>
            </ConsoleSection>

            <ConsoleSection
              id="studio-controls"
              index="03"
              title="Studio break"
              lead="Open a break, shape a shell below, then approve the community design when it reaches review."
            >
              <section aria-label="Synthetic studio controls" className={styles.controls}>
                {button('Start break studio', { action: 'studioStart' }, true)}
                {button('End break', { action: 'studioStop' })}
                {phase === 'REVIEW' && (
                  <>
                    {button('Approve design', { action: 'review', decision: 'approve' }, true)}
                    {button('Keep current design', { action: 'review', decision: 'keep' })}
                  </>
                )}
              </section>
            </ConsoleSection>

            <ConsoleSection
              id="channel"
              index="04"
              title="The living channel"
              lead="The creature, its energy and the current round, refreshed after every step."
            >
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
                <p className={styles.links}>
                  <a href={`/preview${readFragment(judge, channelId)}`}>Inspect round details</a>
                  <a href={`/lineage${readFragment(judge, channelId)}`}>Lineage and passports</a>
                </p>
              )}
            </ConsoleSection>

            <ConsoleSection
              id="replay"
              index="05"
              title="Replay and verify"
              lead="Rebuild the whole expedition from accepted records in a separate world and compare every channel."
            >
              <section aria-label="Replay accepted history" className={styles.replay}>
                <h2>Replay this expedition</h2>
                <button
                  className={styles.emphasis}
                  disabled={busy}
                  onClick={() =>
                    void run(async () => {
                      const report = replaySchema.parse(
                        await sandboxRequest(`/api/sandbox/${judge.worldId}/replay`, judge),
                      );
                      setReplay(report);
                      const verified = report.sourceComparison?.every((entry) => entry.equal);
                      if (verified === true) reach(judge, 'replayed');
                      setMessage(
                        verified === true
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
            </ConsoleSection>
          </>
        )}
      </main>
      {judge && studio?.challenge && phase === 'CREATING' && (
        <div className={styles.editor}>
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
        </div>
      )}
    </ConsoleShell>
  );
}
