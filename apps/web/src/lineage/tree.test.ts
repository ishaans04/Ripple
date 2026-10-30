import { describe, expect, it } from 'vitest';
import { founderShell } from '@ripple/contracts';
import {
  buildForest,
  descendantCount,
  filterHosts,
  visibleUnderFilter,
  type LineageNode,
} from './tree.ts';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const host = (n: number) => ({ channelId: id(100 + n), label: `Host ${n}` });
function node(n: number, parent: number | null, generation: number, at: number): LineageNode {
  return {
    id: id(n),
    parentId: parent === null ? null : id(parent),
    founderId: id(1),
    generation,
    name: `Branch ${n}`,
    genome: { pulse: 6, calm: 6, grit: 6, drift: 6 },
    health: 50,
    status: 'ALIVE',
    appearance: { kind: 'founder', rendererVersion: 'shell-v1', part: founderShell },
    appearanceMapping: 1,
    marks: { origin: host(0), ancestry: [] },
    hosts: [host(0)],
    createdAt: '2026-10-30T00:00:00.000Z',
    lastHost: {
      ...host(at),
      role: 'resident',
      startedAt: '2026-10-30T00:00:00.000Z',
      endedAt: null,
    },
    birth: null,
    emittedTraces: 0,
    latestTrace: null,
  };
}
const nodes = [node(5, 2, 2, 3), node(1, null, 0, 0), node(3, 1, 1, 2), node(2, 1, 1, 1)];

describe('lineage forest', () => {
  it('nests loaded branches under their parents in generation/ID order', () => {
    const [root] = buildForest(nodes);
    expect(root?.node.id).toBe(id(1));
    expect(root?.children.map((child) => child.node.id)).toEqual([id(2), id(3)]);
    expect(root?.children[0]?.children.map((child) => child.node.id)).toEqual([id(5)]);
    expect(descendantCount(root!)).toBe(3);
  });
  it('keeps a branch whose parent is not loaded visible as a root and ignores duplicates', () => {
    const forest = buildForest([node(5, 2, 2, 3), node(5, 2, 2, 3)]);
    expect(forest.map((branch) => branch.node.id)).toEqual([id(5)]);
  });
  it('filters by current or last host while keeping ancestors for context', () => {
    const forest = buildForest(nodes);
    expect(visibleUnderFilter(forest, null)).toEqual(new Set(nodes.map((item) => item.id)));
    expect(visibleUnderFilter(forest, host(3).channelId)).toEqual(new Set([id(1), id(2), id(5)]));
    expect(visibleUnderFilter(forest, host(9).channelId)).toEqual(new Set());
    expect(filterHosts(nodes).map((item) => item.label)).toEqual([
      'Host 0',
      'Host 1',
      'Host 2',
      'Host 3',
    ]);
  });
});
