import type { LineagePage } from '@ripple/contracts';

export type LineageNode = LineagePage['nodes'][number];
export interface TreeBranch {
  readonly node: LineageNode;
  readonly children: readonly TreeBranch[];
}

const order = (a: LineageNode, b: LineageNode) =>
  a.generation - b.generation || a.id.localeCompare(b.id);

/**
 * Builds the family forest from loaded pages. Pages arrive in generation order, so parents load
 * before children; a node whose parent is not loaded is shown as a root rather than dropped.
 */
export function buildForest(nodes: readonly LineageNode[]): TreeBranch[] {
  const unique = new Map(nodes.map((node) => [node.id, node])),
    children = new Map<string, LineageNode[]>();
  for (const node of unique.values())
    if (node.parentId !== null && unique.has(node.parentId))
      children.set(node.parentId, [...(children.get(node.parentId) ?? []), node]);
  const branch = (node: LineageNode): TreeBranch => ({
    node,
    children: (children.get(node.id) ?? []).sort(order).map(branch),
  });
  return [...unique.values()]
    .filter((node) => node.parentId === null || !unique.has(node.parentId))
    .sort(order)
    .map(branch);
}

/** Channels where loaded branches live or last lived, for the host filter, in label order. */
export function filterHosts(nodes: readonly LineageNode[]) {
  const hosts = new Map<string, string>();
  for (const node of nodes)
    if (node.lastHost !== null) hosts.set(node.lastHost.channelId, node.lastHost.label);
  return [...hosts]
    .map(([channelId, label]) => ({ channelId, label }))
    .sort((a, b) => a.label.localeCompare(b.label) || a.channelId.localeCompare(b.channelId));
}

/**
 * Branches shown under a host filter: every branch that lives or last lived at that host, plus
 * its ancestors so the family structure stays readable. Null shows everything.
 */
export function visibleUnderFilter(
  forest: readonly TreeBranch[],
  channelId: string | null,
): Set<string> {
  const visible = new Set<string>();
  const visit = (branch: TreeBranch): boolean => {
    const own = channelId === null || branch.node.lastHost?.channelId === channelId;
    let descendant = false;
    for (const child of branch.children) descendant = visit(child) || descendant;
    if (own || descendant) visible.add(branch.node.id);
    return own || descendant;
  };
  forest.forEach(visit);
  return visible;
}

export function descendantCount(branch: TreeBranch): number {
  return branch.children.reduce((sum, child) => sum + 1 + descendantCount(child), 0);
}
