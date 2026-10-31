import { useEffect, useRef, useState } from 'react';
import { z } from 'zod';
import { controllerStatusSchema, type ControllerStatus } from '@ripple/contracts';
import { liveRequest, controlMessage, LiveRequestError } from './api.ts';
import { ChannelCard } from './ChannelCard.tsx';
import { AdmissionControls } from './AdmissionControls.tsx';
import { HistoricalRaids } from './HistoricalRaids.tsx';
import { TraceControls } from './TraceControls.tsx';
import { StudioCard } from './StudioCard.tsx';
import { DisplayControls } from './DisplayControls.tsx';
import { CelebrationsCard } from './CelebrationsCard.tsx';
import { admissionLabel } from './PropagationCard.tsx';
import { ConsoleSection, ConsoleShell } from '../console/ConsoleShell.tsx';
import { controllerGuide, controllerTour } from '../console/guide.ts';
import styles from './Controller.module.css';
interface Pending {
  id: string;
  action: string;
  payload: Record<string, unknown>;
}
export default function Controller() {
  const completedOperation = useRef<string | null>(null);
  const [enabled, setEnabled] = useState<boolean | null>(null),
    [status, setStatus] = useState<ControllerStatus | null>(null),
    [message, setMessage] = useState('Checking connection…'),
    [name, setName] = useState(''),
    [pending, setPending] = useState<Pending | null>(null),
    [busy, setBusy] = useState(false),
    [readUrl, setReadUrl] = useState(''),
    [operatorSecret, setOperatorSecret] = useState('');
  useEffect(() => {
    const lifetime = { stopped: false };
    const isActive = (): boolean => !lifetime.stopped;
    let timer: ReturnType<typeof setTimeout> | undefined;
    async function refresh() {
      try {
        const connection = z
          .object({ liveEnabled: z.boolean() })
          .parse(await liveRequest('/api/connection'));
        if (!isActive()) return;
        setEnabled(connection.liveEnabled);
        if (connection.liveEnabled) {
          try {
            const claim = z
              .uuid()
              .safeParse(new URLSearchParams(location.hash.slice(1)).get('claim'));
            const state = controllerStatusSchema.parse(
              await liveRequest(
                `/api/controller/status${claim.success ? `?claim=${claim.data}` : ''}`,
              ),
            );
            if (isActive()) {
              setStatus(state);
              setMessage((current) =>
                current === 'Checking connection…' ? 'Connected to your controller.' : current,
              );
            }
          } catch (error) {
            if (isActive()) {
              setStatus(null);
              setMessage(controlMessage(error instanceof Error ? error.message : 'REQUEST_FAILED'));
            }
          }
        } else
          setMessage(
            'Live Twitch is disabled on this installation. Local Studio practice is available.',
          );
      } catch {
        if (isActive()) setMessage('The server is unavailable. Connection checks will retry.');
      } finally {
        if (isActive())
          timer = setTimeout(() => {
            void refresh();
          }, 3000);
      }
    }
    void refresh();
    return () => {
      lifetime.stopped = true;
      clearTimeout(timer);
    };
  }, []);
  useEffect(() => {
    if (pending === null) return;
    const operationId = pending.id;
    const lifetime = { stopped: false };
    const isActive = (): boolean => !lifetime.stopped;
    let timer: ReturnType<typeof setTimeout> | undefined;
    async function check() {
      try {
        const operation = z
          .object({
            result: z
              .object({
                code: z.string(),
                detail: z
                  .object({
                    historical: z.boolean().optional(),
                    outcome: z.string().optional(),
                  })
                  .optional(),
              })
              .nullable(),
          })
          .parse(await liveRequest(`/api/controller/commands/${operationId}`));
        if (isActive() && operation.result !== null) {
          completedOperation.current = operationId;
          setPending(null);
          setMessage(
            operation.result.code === 'APPLIED'
              ? operation.result.detail?.outcome === undefined
                ? 'Change committed.'
                : `${operation.result.detail.historical === true ? 'Historical adoption recorded.' : 'Change committed.'} ${admissionLabel(operation.result.detail.outcome)}.`
              : controlMessage(operation.result.code),
          );
          return;
        }
      } catch {
        /* The command may not have reached the server. Keep its original id for an explicit retry. */
      }
      if (isActive())
        timer = setTimeout(() => {
          void check();
        }, 2000);
    }
    void check();
    return () => {
      lifetime.stopped = true;
      clearTimeout(timer);
    };
  }, [pending]);
  async function send(command: Pending) {
    if (status?.csrfToken === undefined) return;
    setBusy(true);
    setPending(command);
    try {
      // Studio-scoped actions carry their own absolute path; channel actions are relative.
      const path = command.action.startsWith('/')
        ? command.action
        : `/api/channels/${status.channelId}/${command.action}`;
      await liveRequest(path, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-csrf-token': status.csrfToken,
          'idempotency-key': command.id,
        },
        body: JSON.stringify(command.payload),
      });
      if (completedOperation.current !== command.id)
        setMessage('Command accepted. Waiting for its committed result.');
    } catch (error) {
      if (completedOperation.current !== command.id) {
        if (error instanceof LiveRequestError && error.status < 500) setPending(null);
        setMessage(controlMessage(error instanceof Error ? error.message : 'REQUEST_FAILED'));
      }
    } finally {
      setBusy(false);
    }
  }
  function control(action: string, extra: Record<string, unknown> = {}) {
    if (status?.snapshot === null || status === null) return;
    void send({
      id: crypto.randomUUID(),
      action,
      payload: { expectedVersion: status.snapshot.version, ...extra },
    });
  }
  async function createReadLink() {
    if (status?.csrfToken === undefined) return;
    setBusy(true);
    try {
      const result = z
        .object({ worldId: z.uuid(), channelId: z.uuid(), capability: z.string() })
        .parse(
          await liveRequest('/api/controller/read-capability', {
            method: 'POST',
            headers: { 'x-csrf-token': status.csrfToken },
          }),
        );
      setReadUrl(`${location.origin}/preview#${new URLSearchParams(result)}`);
      setMessage('New read-only preview link created. Previous read links were revoked.');
    } catch (error) {
      setMessage(controlMessage(error instanceof Error ? error.message : 'REQUEST_FAILED'));
    } finally {
      setBusy(false);
    }
  }
  async function connectBot() {
    setBusy(true);
    try {
      const result = z.object({ authorizationUrl: z.url() }).parse(
        await liveRequest('/auth/twitch/bot/start', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ operatorSecret }),
        }),
      );
      setOperatorSecret('');
      location.assign(result.authorizationUrl);
    } catch (error) {
      setMessage(controlMessage(error instanceof Error ? error.message : 'REQUEST_FAILED'));
    } finally {
      setBusy(false);
    }
  }
  const disabled = busy || pending !== null || status?.csrfToken === undefined;
  const steps = controllerGuide(enabled, status);
  const channel = status?.snapshot?.payload ?? null;
  const connection = status === null ? 'signed-out' : status.botAuthorized ? 'ready' : 'partial';
  return (
    <ConsoleShell
      label="Broadcaster console"
      storageKey="controller"
      steps={steps}
      tour={controllerTour}
      welcome="This console runs your channel’s strain. The rail on the left shows every chapter, and Up next always names the one thing to do now. A one-minute tour points at each part."
      extraNext={
        enabled === false ? (
          <p>
            Try the full game in the <a href="/sandbox">synthetic sandbox</a> or shape a shell in{' '}
            <a href="/studio">Cocoon Studio</a>.
          </p>
        ) : (
          <p>Your strain is live. Optional chapters remain whenever you want them.</p>
        )
      }
      links={[
        { href: '/', label: 'Home' },
        { href: '/sandbox', label: 'Sandbox' },
        { href: '/studio', label: 'Local Studio practice' },
        { href: '/privacy', label: 'Privacy' },
      ]}
    >
      <main className={styles.page}>
        <header className={styles.top}>
          <div className={styles.topText}>
            <p className={styles.eyebrow}>Broadcaster console</p>
            <h1 className={styles.title}>Channel controller</h1>
          </div>
          <p role="status" className={styles.statusPill} data-connection={connection}>
            {message}
          </p>
        </header>

        <ConsoleSection
          id="connect"
          index="01"
          title="Connect"
          lead="Sign in once. Ripple then checks the chat bot and Twitch events by itself and keeps re-checking every few seconds."
        >
          {enabled === true && status === null && (
            <div className={styles.connectCard}>
              <div>
                <p className={styles.connectTitle}>Bring your community’s strain to life.</p>
                <p className={styles.muted}>
                  You will be sent to Twitch to approve Ripple, then returned here. Ripple reads
                  votes, raids and chat rhythm; it never posts as you.
                </p>
              </div>
              <a className={styles.button} href="/auth/twitch/start">
                Connect broadcaster with Twitch
              </a>
            </div>
          )}
          {enabled === false && (
            <div className={styles.connectCard}>
              <div>
                <p className={styles.connectTitle}>Live Twitch is off on this installation.</p>
                <p className={styles.muted}>
                  Everything else still works. Run a complete synthetic expedition, or practise
                  shaping a shell by hand.
                </p>
              </div>
              <div className={styles.actions}>
                <a className={styles.button} href="/sandbox">
                  Open the sandbox
                </a>
                <a className={styles.secondaryLink} href="/studio">
                  Practise in Cocoon Studio
                </a>
              </div>
            </div>
          )}
          {status !== null && (
            <section className={styles.panel}>
              <h2>Connection steps</h2>
              <ul className={styles.checklist}>
                <li data-ok="true">Broadcaster authorization: ready</li>
                <li data-ok={status.botAuthorized}>
                  Operator bot:{' '}
                  {status.botAuthorized ? 'authorized' : 'operator authorization needed'}
                </li>
                <li data-ok={status.callbackReady}>
                  Signed callback:{' '}
                  {status.callbackReady ? 'verified' : 'waiting for Twitch verification'}
                </li>
                <li data-ok={status.subscriptionsReady}>
                  Subscriptions:{' '}
                  {status.subscriptionsReady
                    ? 'enabled'
                    : 'pending — automatic reconciliation retries'}
                </li>
                <li data-ok={status.readClients > 0}>
                  Read-only preview: {status.readClients > 0 ? 'connected' : 'not connected'}
                </li>
              </ul>
              {status.settings.input_error !== null && (
                <p role="alert">{controlMessage(status.settings.input_error)}</p>
              )}
              {status.subscriptions.length > 0 && (
                <ul className={styles.subscriptions}>
                  {status.subscriptions.map((s) => (
                    <li key={s.type}>
                      {s.type}: {controlMessage(s.status)}
                    </li>
                  ))}
                </ul>
              )}
            </section>
          )}
          {enabled === true && (
            <details className={styles.panel}>
              <summary>Operator bot setup</summary>
              <p>
                The deployment operator authorizes one bot for this installation. Viewers do not
                need this secret.
              </p>
              <label>
                Operator secret
                <input
                  type="password"
                  autoComplete="off"
                  value={operatorSecret}
                  onChange={(e) => {
                    setOperatorSecret(e.target.value);
                  }}
                />
              </label>
              <button
                disabled={busy || operatorSecret.length < 32}
                onClick={() => {
                  void connectBot();
                }}
              >
                Authorize bot account
              </button>
            </details>
          )}
        </ConsoleSection>

        {status !== null && (
          <>
            <ConsoleSection
              id="strain"
              index="02"
              title="Your strain"
              lead="Name the founding strain and seed it. Chat then votes on each mutation with !ripple 1, 2 or 3 while the stream’s rhythm becomes its habitat."
            >
              {channel !== null && <ChannelCard channel={channel} worldId={status.worldId} />}
              <section className={styles.panel}>
                <h2>Strain controls</h2>
                <label>
                  Approved strain name
                  <input
                    value={name}
                    maxLength={40}
                    placeholder="For example: Tide Walker"
                    onChange={(e) => {
                      setName(e.target.value);
                    }}
                  />
                </label>
                <div className={styles.actions}>
                  <button
                    className={styles.primaryButton}
                    disabled={disabled || name.trim().length === 0}
                    onClick={() => {
                      control('seed', { name });
                    }}
                  >
                    Seed strain
                  </button>
                  <button
                    disabled={disabled || name.trim().length === 0 || !channel?.organism}
                    onClick={() => {
                      control('rename', { name, organismId: channel?.organism?.id });
                    }}
                  >
                    Rename resident
                  </button>
                  <button
                    disabled={disabled}
                    onClick={() => {
                      control('pause');
                    }}
                  >
                    Pause
                  </button>
                  <button
                    disabled={disabled}
                    onClick={() => {
                      control('resume');
                    }}
                  >
                    Resume
                  </button>
                  <button
                    disabled={disabled}
                    onClick={() => {
                      control('recover');
                    }}
                  >
                    Recover interrupted observation
                  </button>
                </div>
                <p className={styles.muted}>
                  Seeding cooldown: {status.settings.seed_cooldown_ms / 1000} seconds
                  {status.settings.last_seed_at === null
                    ? ''
                    : ` · Last seed ${new Date(status.settings.last_seed_at).toLocaleTimeString()}`}
                </p>
                {pending !== null && (
                  <button
                    disabled={busy}
                    onClick={() => {
                      void send(pending);
                    }}
                  >
                    Retry pending command
                  </button>
                )}
              </section>
            </ConsoleSection>

            <ConsoleSection
              id="visitors"
              index="03"
              title="Visitors and raids"
              lead="A raid sends a descendant along with your viewers while your resident stays home. Decide how strains raided into your channel are treated."
            >
              <div className={styles.panel}>
                <label>
                  Visitor policy
                  <select
                    value={status.settings.visitor_policy}
                    disabled={disabled}
                    onChange={(e) => {
                      control('policy', { visitorPolicy: e.target.value });
                    }}
                  >
                    <option value="ask">Ask the receiving community</option>
                    <option value="accept">Accept eligible visitors</option>
                    <option value="reject">Reject visitors</option>
                  </select>
                </label>
              </div>
              {channel?.propagation !== undefined && status.snapshot !== null && (
                <AdmissionControls
                  view={channel.propagation}
                  version={status.snapshot.version}
                  disabled={disabled}
                  control={(body) => {
                    control('control', body);
                  }}
                />
              )}
              <HistoricalRaids
                requested={
                  z.uuid().safeParse(new URLSearchParams(location.hash.slice(1)).get('claim'))
                    .success
                }
                offers={status.historicalOffers ?? []}
                outgoing={channel?.propagation?.outgoing ?? []}
                disabled={disabled}
                control={(body) => {
                  control('control', body);
                }}
              />
            </ConsoleSection>

            <ConsoleSection
              id="stream"
              index="04"
              title="On stream"
              lead="Create one private link. It opens a read-only preview, the lineage map and the transparent OBS overlay; rotating it revokes all three."
            >
              <section className={styles.panel}>
                <h2>Read-only preview</h2>
                <p>
                  This link reads game state and cannot send controls or votes. Keep it private.
                </p>
                <button
                  className={styles.primaryButton}
                  disabled={busy}
                  onClick={() => {
                    void createReadLink();
                  }}
                >
                  Create or rotate preview link
                </button>
                {readUrl !== '' && (
                  <>
                    <label>
                      Preview URL
                      <input
                        readOnly
                        value={readUrl}
                        onFocus={(e) => {
                          e.target.select();
                        }}
                      />
                    </label>
                    <div className={styles.actions}>
                      <a href={readUrl} target="_blank" rel="noreferrer">
                        Open read-only preview
                      </a>
                      <a
                        href={readUrl.replace('/preview#', '/lineage#')}
                        target="_blank"
                        rel="noreferrer"
                      >
                        Open lineage map and passports
                      </a>
                    </div>
                    <label>
                      OBS browser source URL
                      <input
                        readOnly
                        value={readUrl.replace('/preview#', '/overlay#')}
                        onFocus={(e) => {
                          e.target.select();
                        }}
                      />
                    </label>
                    <p className={styles.muted}>
                      Paste the OBS URL into a 1920×1080 browser source. Its canvas is transparent.
                      It shares this read-only capability; rotating the link revokes both.
                    </p>
                  </>
                )}
              </section>
              {channel !== null && status.snapshot !== null && (
                <DisplayControls
                  channel={channel}
                  version={status.snapshot.version}
                  disabled={disabled}
                  control={(body) => {
                    control('control', body);
                  }}
                />
              )}
              <CelebrationsCard status={status} />
            </ConsoleSection>

            {channel !== null && (
              <ConsoleSection
                id="studio"
                index="05"
                title="Cocoon Studio"
                lead="During a break, viewers sculpt a new shell with their hands or a pointer. Chat picks a finalist and nothing hatches until you approve it."
              >
                <StudioCard
                  channel={channel}
                  disabled={disabled}
                  csrfToken={status.csrfToken}
                  control={control}
                />
              </ConsoleSection>
            )}

            {channel !== null && status.snapshot !== null && (
              <ConsoleSection
                id="mechanics"
                index="06"
                title="Habitat traces"
                lead="Optional rules: a visitor that survives can leave a fading mark on your channel, and minority choices can return later as dormant options."
              >
                <TraceControls
                  channel={channel}
                  version={status.snapshot.version}
                  disabled={disabled}
                  control={(body) => {
                    control('control', body);
                  }}
                />
              </ConsoleSection>
            )}

            <div className={styles.signOut}>
              <button
                onClick={() => {
                  void liveRequest('/auth/logout', { method: 'POST' }).then(() => {
                    location.reload();
                  });
                }}
              >
                Sign out
              </button>
            </div>
          </>
        )}
      </main>
    </ConsoleShell>
  );
}
