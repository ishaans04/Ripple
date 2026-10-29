import { useEffect, useState } from 'react';
import { blocksPageSchema, type BlocksPage, type PropagationView } from '@ripple/contracts';
import { liveRequest, controlMessage } from './api.ts';
import { admissionLabel } from './PropagationCard.tsx';
import styles from './Controller.module.css';

export function AdmissionControls({
  view,
  version,
  disabled,
  control,
}: {
  view: PropagationView;
  version: number;
  disabled: boolean;
  control: (body: Record<string, unknown>) => void;
}) {
  const [kind, setKind] = useState<'source' | 'lineage'>('source'),
    [after, setAfter] = useState<string | null>(null);
  const [page, setPage] = useState<BlocksPage | null>(null),
    [error, setError] = useState(''),
    [retry, setRetry] = useState(0);
  useEffect(() => {
    const state = { stopped: false };
    void liveRequest(
      `/api/controller/blocks?${new URLSearchParams({ kind, ...(after === null ? {} : { after }) })}`,
    )
      .then((data) => {
        if (!state.stopped) {
          setPage(blocksPageSchema.parse(data));
          setError('');
        }
      })
      .catch((reason: unknown) => {
        if (!state.stopped) {
          setPage(null);
          setError(controlMessage(reason instanceof Error ? reason.message : 'REQUEST_FAILED'));
        }
      });
    return () => {
      state.stopped = true;
    };
  }, [kind, after, version, retry]);
  return (
    <section className={styles.panel} aria-label="Visitor controls">
      <h2>Preparation and visitors</h2>
      <button
        disabled={disabled || view.resident === null || view.preparationRequested}
        onClick={() => {
          control({ action: 'prepare' });
        }}
      >
        Queue preparation ballot
      </button>
      <p>
        Preparation and welcome choices begin at a safe ballot boundary. A raid never waits for an
        unfinished vote.
      </p>
      {view.admissions.map((t) => (
        <section key={t.id} aria-label={`Visitor from ${t.sourceLabel}`}>
          <h3>From {t.sourceLabel}</h3>
          <p>{admissionLabel(t.outcome)}</p>
          {t.outcome !== 'ACTIVE' && (
            <button
              disabled={disabled}
              onClick={() => {
                control({
                  action: 'admission',
                  transferId: t.id,
                  transferVersion: t.version,
                  decision: 'accept',
                });
              }}
            >
              Approve visitor from {t.sourceLabel}
            </button>
          )}
          <button
            disabled={disabled}
            onClick={() => {
              control({
                action: 'admission',
                transferId: t.id,
                transferVersion: t.version,
                decision: 'decline',
              });
            }}
          >
            Decline visitor from {t.sourceLabel}
          </button>
          <button
            disabled={disabled}
            onClick={() => {
              control({ action: 'blockSource', sourceChannelId: t.sourceChannelId, blocked: true });
            }}
          >
            Block source {t.sourceLabel}
          </button>
          {t.lineageId !== null && (
            <button
              disabled={disabled}
              onClick={() => {
                control({ action: 'blockLineage', lineageId: t.lineageId, blocked: true });
              }}
            >
              Block this lineage
            </button>
          )}
        </section>
      ))}
      <p>
        Approval respects offline, authorization and capacity holds. Decline archives the visitor.
        Blocking refuses waiting and future arrivals; decline an active visitor separately.
      </p>
      <h3>Admission blocks</h3>
      <label>
        Block list
        <select
          value={kind}
          onChange={(e) => {
            setKind(e.target.value === 'lineage' ? 'lineage' : 'source');
            setAfter(null);
            setPage(null);
          }}
        >
          <option value="source">Source channels</option>
          <option value="lineage">Lineages</option>
        </select>
      </label>
      {error !== '' && <p role="alert">{error}</p>}
      {page === null ? (
        <button
          onClick={() => {
            setRetry((n) => n + 1);
          }}
        >
          Reload blocks
        </button>
      ) : (
        <>
          {page.items.length === 0 && <p>No blocks on this page.</p>}
          <ul>
            {page.items.map((item) => (
              <li key={item.id}>
                {page.kind === 'lineage' ? 'Lineage from ' : ''}
                {item.label} · <code>{item.id}</code>{' '}
                <button
                  disabled={disabled}
                  onClick={() => {
                    control(
                      page.kind === 'source'
                        ? { action: 'blockSource', sourceChannelId: item.id, blocked: false }
                        : { action: 'blockLineage', lineageId: item.id, blocked: false },
                    );
                  }}
                >
                  Unblock {item.label}
                </button>
              </li>
            ))}
          </ul>
          {after !== null && (
            <button
              onClick={() => {
                setAfter(null);
                setPage(null);
              }}
            >
              First page
            </button>
          )}
          {page.next !== null && (
            <button
              onClick={() => {
                setAfter(page.next);
                setPage(null);
              }}
            >
              Next blocks
            </button>
          )}
        </>
      )}
    </section>
  );
}
