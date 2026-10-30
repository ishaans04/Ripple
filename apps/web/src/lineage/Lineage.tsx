import { useEffect, useState } from 'react';
import type { LineageCatalog, LineagePage, Passport as PassportRecord } from '@ripple/contracts';
import { readLinkFromHash, type ReadLink } from '../realtime/read-link.ts';
import { track } from '../realtime/analytics.ts';
import { traceTitle } from '../realtime/trace-labels.ts';
import { ReadFailure, readCatalog, readLineagePage, readPassport } from './api.ts';
import { Passport } from './Passport.tsx';
import {
  buildForest,
  descendantCount,
  filterHosts,
  visibleUnderFilter,
  type LineageNode,
  type TreeBranch,
} from './tree.ts';
import styles from './Lineage.module.css';

type Problem = ReadFailure['kind'] | 'invalid';
const problemText: Readonly<Record<Problem, string>> = {
  invalid: 'This lineage link is incomplete. Ask the broadcaster for a new read-only link.',
  unauthorized: 'This link was revoked or expired. Ask the broadcaster for a new link.',
  unavailable: 'This record is not available to this channel.',
  failed: 'Ripple could not load this view.',
};
const statusText = {
  ALIVE: 'living',
  HARBOR: 'in a harbor',
  FOSSIL: 'fossil',
  ARCHIVED: 'archived',
} as const;
const count = (value: number, noun: string, plural = `${noun}s`) =>
  `${value} ${value === 1 ? noun : plural}`;
const kind = (error: unknown): Problem => (error instanceof ReadFailure ? error.kind : 'failed');

function traceNote(node: LineageNode) {
  if (node.emittedTraces === 0 || node.latestTrace === null) return null;
  const trace = node.latestTrace;
  return `${node.emittedTraces} trace${node.emittedTraces === 1 ? '' : 's'} earned · latest ${traceTitle[trace.template]} at ${trace.host.label} (${trace.status})`;
}

function Branch({
  branch,
  visible,
  collapsed,
  selectedId,
  onToggle,
  onSelect,
}: {
  branch: TreeBranch;
  visible: ReadonlySet<string>;
  collapsed: ReadonlySet<string>;
  selectedId: string | null;
  onToggle: (id: string) => void;
  onSelect: (id: string) => void;
}) {
  const { node } = branch,
    open = !collapsed.has(node.id),
    shown = branch.children.filter((child) => visible.has(child.node.id)),
    hidden = descendantCount(branch),
    trace = traceNote(node),
    descendants = `${hidden} descendant${hidden === 1 ? '' : 's'}`;
  return (
    <li className={node.status === 'FOSSIL' ? styles.fossilBranch : undefined}>
      <div className={styles.branchRow}>
        {shown.length > 0 ? (
          <button
            type="button"
            className={styles.toggle}
            aria-expanded={open}
            aria-label={`${open ? 'Collapse' : 'Expand'} ${node.name}'s ${descendants}`}
            onClick={() => {
              onToggle(node.id);
            }}
          >
            {open ? '−' : '+'}
          </button>
        ) : (
          <span className={styles.leaf} aria-hidden="true">
            ·
          </span>
        )}
        <button
          type="button"
          className={styles.branchButton}
          aria-current={selectedId === node.id ? 'true' : undefined}
          onClick={() => {
            onSelect(node.id);
          }}
        >
          <strong>{node.name}</strong>
          <span>
            Generation {node.generation} · {statusText[node.status]} · energy {node.health}
            {node.lastHost === null
              ? ' · not yet admitted'
              : ` · ${node.lastHost.endedAt === null ? 'at' : 'last at'} ${node.lastHost.label}`}
          </span>
          {trace !== null && <span>{trace}</span>}
          {!open && <span>{descendants} hidden</span>}
        </button>
      </div>
      {open && shown.length > 0 && (
        <ul>
          {shown.map((child) => (
            <Branch
              key={child.node.id}
              branch={child}
              visible={visible}
              collapsed={collapsed}
              selectedId={selectedId}
              onToggle={onToggle}
              onSelect={onSelect}
            />
          ))}
        </ul>
      )}
    </li>
  );
}

export default function Lineage() {
  const [link, setLink] = useState<ReadLink | null>(() => readLinkFromHash(location.hash)),
    [catalog, setCatalog] = useState<LineageCatalog | null>(null),
    [lineageId, setLineageId] = useState<string | null>(null),
    // Fetched results are keyed by the request they answer, so a stale result is never shown.
    [branches, setBranches] = useState<{ lineageId: string; pages: LineagePage[] } | null>(null),
    [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set()),
    [hostFilter, setHostFilter] = useState<string | null>(null),
    [selectedId, setSelectedId] = useState<string | null>(null),
    [record, setRecord] = useState<{
      organismId: string;
      passport: PassportRecord | null;
      problem: Problem | null;
    } | null>(null),
    [problem, setProblem] = useState<Problem | null>(link === null ? 'invalid' : null),
    [loading, setLoading] = useState(false),
    [attempt, setAttempt] = useState(0);

  useEffect(() => {
    const changed = () => {
      const next = readLinkFromHash(location.hash);
      setLink(next);
      setCatalog(null);
      setLineageId(null);
      setBranches(null);
      setSelectedId(null);
      setRecord(null);
      setProblem(next === null ? 'invalid' : null);
    };
    window.addEventListener('hashchange', changed);
    return () => {
      window.removeEventListener('hashchange', changed);
    };
  }, []);

  useEffect(() => {
    if (link === null) return;
    let stale = false;
    readCatalog(link, null).then(
      (result) => {
        if (stale) return;
        setCatalog(result);
        setProblem(null);
        setLineageId((current) => current ?? result.lineages[0]?.lineageId ?? null);
      },
      (error: unknown) => {
        if (!stale) setProblem(kind(error));
      },
    );
    return () => {
      stale = true;
    };
  }, [link, attempt]);

  useEffect(() => {
    if (link === null || lineageId === null) return;
    let stale = false;
    readLineagePage(link, lineageId, null).then(
      (page) => {
        if (stale) return;
        setBranches({ lineageId, pages: [page] });
        const home =
          page.nodes.find(
            (node) => node.lastHost?.channelId === link.channelId && node.lastHost.endedAt === null,
          ) ?? page.nodes[0];
        setSelectedId(home?.id ?? null);
      },
      (error: unknown) => {
        if (!stale) setProblem(kind(error));
      },
    );
    return () => {
      stale = true;
    };
  }, [link, lineageId, attempt]);

  useEffect(() => {
    if (link === null || selectedId === null) return;
    let stale = false;
    readPassport(link, selectedId, null).then(
      (passport) => {
        if (!stale) setRecord({ organismId: selectedId, passport, problem: null });
        track('passport_opened', {
          kind: 'channel',
          worldId: link.worldId,
          channelId: link.channelId,
        });
      },
      (error: unknown) => {
        if (!stale) setRecord({ organismId: selectedId, passport: null, problem: kind(error) });
      },
    );
    return () => {
      stale = true;
    };
  }, [link, selectedId, attempt]);

  const pages = branches?.lineageId === lineageId ? branches.pages : [],
    current = record?.organismId === selectedId ? record : null,
    passport = current?.passport ?? null,
    passportProblem = current?.problem ?? null,
    nodes = pages.flatMap((page) => page.nodes),
    forest = buildForest(nodes),
    visible = visibleUnderFilter(forest, hostFilter),
    hosts = filterHosts(nodes),
    lineage = pages[0],
    nextBranches = pages.at(-1)?.next ?? null,
    selected = nodes.find((node) => node.id === selectedId);

  async function more(action: () => Promise<void>) {
    setLoading(true);
    try {
      await action();
    } catch (error) {
      setProblem(kind(error));
    } finally {
      setLoading(false);
    }
  }

  if (problem !== null || link === null)
    return (
      <main className={styles.page}>
        <h1>Ripple lineages</h1>
        <p role="alert">{problemText[problem ?? 'invalid']}</p>
        {problem === 'failed' && (
          <button
            type="button"
            onClick={() => {
              setProblem(null);
              setAttempt((value) => value + 1);
            }}
          >
            Try again
          </button>
        )}
      </main>
    );
  return (
    <main className={styles.page}>
      <header className={styles.top}>
        <h1>Ripple lineages</h1>
        {catalog !== null && catalog.mode !== 'live' && (
          <p className={styles.badge}>
            {catalog.mode === 'sandbox' ? 'Synthetic world' : 'Recorded replay'}
          </p>
        )}
      </header>
      {catalog === null ? (
        <p role="status">Loading lineages…</p>
      ) : catalog.total === 0 ? (
        <p role="status">
          No lineage has started here or visited yet. Seed a strain from the controller.
        </p>
      ) : (
        <div className={styles.layout}>
          <section className={styles.treePanel} aria-labelledby="lineage-tree">
            <h2 id="lineage-tree">Lineage map</h2>
            <label htmlFor="lineage-choice">Lineage ({catalog.total})</label>
            <select
              id="lineage-choice"
              value={lineageId ?? ''}
              onChange={(event) => {
                setLineageId(event.target.value);
                setCollapsed(new Set());
                setHostFilter(null);
              }}
            >
              {catalog.lineages.map((item) => (
                <option key={item.lineageId} value={item.lineageId}>
                  {item.founder.name} from {item.origin.label} · {item.counts.alive} living,{' '}
                  {item.counts.harbor} waiting, {item.counts.fossil} fossils
                </option>
              ))}
            </select>
            {catalog.next !== null && (
              <button
                type="button"
                disabled={loading}
                onClick={() => {
                  void more(async () => {
                    const page = await readCatalog(link, catalog.next);
                    setCatalog({ ...page, lineages: [...catalog.lineages, ...page.lineages] });
                  });
                }}
              >
                Show more lineages
              </button>
            )}
            {lineage === undefined ? (
              <p role="status">Loading branches…</p>
            ) : (
              <>
                <p>
                  {count(lineage.counts.total, 'branch', 'branches')} · {lineage.counts.alive}{' '}
                  living · {lineage.counts.harbor} waiting ·{' '}
                  {count(lineage.counts.fossil, 'fossil')}
                </p>
                <label htmlFor="host-filter">Host</label>
                <select
                  id="host-filter"
                  value={hostFilter ?? ''}
                  onChange={(event) => {
                    setHostFilter(event.target.value === '' ? null : event.target.value);
                  }}
                >
                  <option value="">All hosts</option>
                  {hosts.map((item) => (
                    <option key={item.channelId} value={item.channelId}>
                      {item.label}
                    </option>
                  ))}
                </select>
                {visible.size === 0 ? (
                  <p role="status">No loaded branch lives at this host.</p>
                ) : (
                  <ul className={styles.tree} aria-label="Family tree">
                    {forest
                      .filter((branch) => visible.has(branch.node.id))
                      .map((branch) => (
                        <Branch
                          key={branch.node.id}
                          branch={branch}
                          visible={visible}
                          collapsed={collapsed}
                          selectedId={selectedId}
                          onToggle={(id) => {
                            setCollapsed((current) => {
                              const next = new Set(current);
                              if (!next.delete(id)) next.add(id);
                              return next;
                            });
                          }}
                          onSelect={setSelectedId}
                        />
                      ))}
                  </ul>
                )}
                {nextBranches !== null && (
                  <button
                    type="button"
                    disabled={loading}
                    onClick={() => {
                      void more(async () => {
                        const page = await readLineagePage(link, lineage.lineageId, nextBranches);
                        setBranches({ lineageId: lineage.lineageId, pages: [...pages, page] });
                      });
                    }}
                  >
                    Load more branches
                  </button>
                )}
              </>
            )}
          </section>
          <section className={styles.passportPanel} aria-label="Selected branch">
            {selected !== undefined &&
              nextBranches === null &&
              !nodes.some((node) => node.parentId === selected.id) && (
                <p>{selected.name} has no descendants yet.</p>
              )}
            {passportProblem !== null ? (
              <p role="alert">{problemText[passportProblem]}</p>
            ) : passport === null ? (
              <p role="status">{selectedId === null ? 'Select a branch.' : 'Loading passport…'}</p>
            ) : (
              <Passport
                passport={passport}
                loadingOlder={loading}
                onOlder={() => {
                  void more(async () => {
                    const older = await readPassport(
                      link,
                      passport.organism.id,
                      passport.adaptations.next,
                    );
                    setRecord({
                      organismId: passport.organism.id,
                      problem: null,
                      passport: {
                        ...older,
                        adaptations: {
                          ...older.adaptations,
                          items: [...passport.adaptations.items, ...older.adaptations.items],
                        },
                      },
                    });
                  });
                }}
              />
            )}
          </section>
        </div>
      )}
    </main>
  );
}
