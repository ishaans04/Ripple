import { useCallback, useEffect, useState } from 'react';
import styles from './ServiceStatusPanel.module.css';
import { describeServiceStatus, fetchServiceStatus, type ServiceStatus } from './serviceStatus.ts';

/** While unavailable, re-check on this interval so the page recovers without a reload. */
const RECHECK_MS = 10_000;

const markers: Record<ServiceStatus['kind'], string> = {
  checking: '…',
  available: '●',
  unavailable: '▲',
};

export function ServiceStatusPanel() {
  const [status, setStatus] = useState<ServiceStatus>({ kind: 'checking' });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    fetchServiceStatus(fetch, controller.signal).then(setStatus, () => {
      // Aborted because the component unmounted or a newer check started.
    });
    return () => {
      controller.abort();
    };
  }, [attempt]);

  useEffect(() => {
    if (status.kind !== 'unavailable') return;
    const timer = setTimeout(() => {
      setAttempt((value) => value + 1);
    }, RECHECK_MS);
    return () => {
      clearTimeout(timer);
    };
  }, [status]);

  const retry = useCallback(() => {
    setStatus({ kind: 'checking' });
    setAttempt((value) => value + 1);
  }, []);

  return (
    <section className={styles.panel} data-state={status.kind} aria-labelledby="service-heading">
      <h2 id="service-heading" className={styles.heading}>
        Service status
      </h2>
      <p className={styles.message} role="status" aria-live="polite">
        <span className={styles.marker} aria-hidden="true">
          {markers[status.kind]}
        </span>
        {describeServiceStatus(status)}
      </p>
      {status.kind === 'unavailable' && (
        <button type="button" className={styles.retry} onClick={retry}>
          Check again
        </button>
      )}
    </section>
  );
}
