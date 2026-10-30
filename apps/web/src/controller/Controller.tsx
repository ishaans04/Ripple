import { useEffect, useRef, useState } from 'react';
import { z } from 'zod';
import { controllerStatusSchema, type ControllerStatus } from '@ripple/contracts';
import { liveRequest, controlMessage, LiveRequestError } from './api.ts';
import { ChannelCard } from './ChannelCard.tsx';
import { AdmissionControls } from './AdmissionControls.tsx';
import { HistoricalRaids } from './HistoricalRaids.tsx';
import { TraceControls } from './TraceControls.tsx';
import { admissionLabel } from './PropagationCard.tsx';
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
      await liveRequest(`/api/channels/${status.channelId}/${command.action}`, {
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
  return (
    <main className={styles.page}>
      <nav>
        <a href="/">Ripple</a> · <a href="/studio">Local Studio practice</a>
      </nav>
      <h1>Channel controller</h1>
      <p role="status">{message}</p>
      {enabled === true && status === null && (
        <a className={styles.button} href="/auth/twitch/start">
          Connect broadcaster with Twitch
        </a>
      )}
      {status !== null && (
        <>
          <section className={styles.panel}>
            <h2>Connection steps</h2>
            <ul>
              <li>Broadcaster authorization: ready</li>
              <li>
                Operator bot:{' '}
                {status.botAuthorized ? 'authorized' : 'operator authorization needed'}
              </li>
              <li>
                Signed callback:{' '}
                {status.callbackReady ? 'verified' : 'waiting for Twitch verification'}
              </li>
              <li>
                Subscriptions:{' '}
                {status.subscriptionsReady
                  ? 'enabled'
                  : 'pending — automatic reconciliation retries'}
              </li>
              <li>Read-only preview: {status.readClients > 0 ? 'connected' : 'not connected'}</li>
            </ul>
            {status.settings.input_error !== null && (
              <p role="alert">{controlMessage(status.settings.input_error)}</p>
            )}
            <ul>
              {status.subscriptions.map((s) => (
                <li key={s.type}>
                  {s.type}: {controlMessage(s.status)}
                </li>
              ))}
            </ul>
          </section>
          {status.snapshot !== null && <ChannelCard channel={status.snapshot.payload} />}
          <section className={styles.panel}>
            <h2>Strain controls</h2>
            <label>
              Approved strain name
              <input
                value={name}
                maxLength={40}
                onChange={(e) => {
                  setName(e.target.value);
                }}
              />
            </label>
            <div className={styles.actions}>
              <button
                disabled={disabled || name.trim().length === 0}
                onClick={() => {
                  control('seed', { name });
                }}
              >
                Seed strain
              </button>
              <button
                disabled={
                  disabled ||
                  name.trim().length === 0 ||
                  status.snapshot?.payload.organism === null ||
                  status.snapshot?.payload.organism === undefined
                }
                onClick={() => {
                  control('rename', { name, organismId: status.snapshot?.payload.organism?.id });
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
            <p>
              Seeding cooldown: {status.settings.seed_cooldown_ms / 1000} seconds
              {status.settings.last_seed_at === null
                ? ''
                : ` · Last seed ${new Date(status.settings.last_seed_at).toLocaleTimeString()}`}
            </p>
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
          {status.snapshot?.payload.propagation !== undefined && (
            <AdmissionControls
              view={status.snapshot.payload.propagation}
              version={status.snapshot.version}
              disabled={disabled}
              control={(body) => {
                control('control', body);
              }}
            />
          )}
          {status.snapshot !== null && (
            <TraceControls
              channel={status.snapshot.payload}
              version={status.snapshot.version}
              disabled={disabled}
              control={(body) => {
                control('control', body);
              }}
            />
          )}
          <HistoricalRaids
            requested={
              z.uuid().safeParse(new URLSearchParams(location.hash.slice(1)).get('claim')).success
            }
            offers={status.historicalOffers ?? []}
            outgoing={status.snapshot?.payload.propagation?.outgoing ?? []}
            disabled={disabled}
            control={(body) => {
              control('control', body);
            }}
          />
          <section className={styles.panel}>
            <h2>Read-only preview</h2>
            <p>This link reads game state and cannot send controls or votes. Keep it private.</p>
            <button
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
                <p>
                  Paste the OBS URL into a 1920×1080 browser source. Its canvas is transparent. It
                  shares this read-only capability; rotating the link revokes both.
                </p>
              </>
            )}
          </section>
          <button
            onClick={() => {
              void liveRequest('/auth/logout', { method: 'POST' }).then(() => {
                location.reload();
              });
            }}
          >
            Sign out
          </button>
        </>
      )}
      {enabled === true && (
        <details className={styles.panel}>
          <summary>Operator bot setup</summary>
          <p>
            The deployment operator authorizes one bot for this installation. Viewers do not need
            this secret.
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
    </main>
  );
}
