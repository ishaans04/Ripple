import {
  inheritValidRoundLifetime,
  type MutationMove,
  type ValidRoundLifetime,
} from '@ripple/engine';
import type { DormantRow } from './dormant-state.ts';
import type { GameContext } from './store.ts';
import { operationId } from './operation-id.ts';

export interface DormantInheritance {
  sourceId: string;
  sourceVersion: number;
  sourceOrganismId: string;
  sourceRoundId: string;
  template: MutationMove;
  provenance: DormantRow['provenance'];
  lifetime: ValidRoundLifetime;
  remainingHops: number;
  offered: boolean;
}

export async function snapshotDormantInheritance(
  context: GameContext,
  parentId: string,
): Promise<DormantInheritance | null> {
  const row = (
    await context.client.query<DormantRow>(
      "select * from dormant_mutations where world_id=$1 and organism_id=$2 and status='active' and remaining_rounds>0",
      [context.channel.world_id, parentId],
    )
  ).rows[0];
  return row === undefined
    ? null
    : {
        sourceId: row.id,
        sourceVersion: row.version,
        sourceOrganismId: parentId,
        sourceRoundId: row.source_round_id,
        template: row.template,
        provenance: row.provenance,
        lifetime: inheritValidRoundLifetime(row.lifetime),
        remainingHops: row.remaining_hops,
        offered: row.offered,
      };
}

/** The child owns a new bounded record; the accepted parent snapshot never changes. */
export async function inheritDormantMutation(
  context: GameContext,
  snapshot: DormantInheritance,
  childId: string,
  transferId: string,
  sequence: number,
): Promise<void> {
  if (snapshot.remainingHops < 1)
    throw new Error('Dormant inheritance exceeds the generation allowance.');
  const lifetime = inheritValidRoundLifetime(snapshot.lifetime);
  await context.client.query(
    `insert into dormant_mutations(world_id,id,organism_id,source_round_id,template,provenance,remaining_hops,remaining_rounds,status,lifetime,offered,blueprint_hash)
     values($1,$2,$3,$4,$5,$6,$7,$8,'active',$9,$10,$11)`,
    [
      context.channel.world_id,
      operationId(context.channel.id, sequence, `dormant-child:${childId}`),
      childId,
      snapshot.sourceRoundId,
      snapshot.template,
      {
        ...snapshot.provenance,
        inheritedFrom: {
          organismId: snapshot.sourceOrganismId,
          dormantId: snapshot.sourceId,
          version: snapshot.sourceVersion,
          transferId,
          sequence,
        },
      },
      snapshot.remainingHops - 1,
      lifetime.remainingRounds,
      lifetime,
      snapshot.offered,
      snapshot.provenance.studio?.blueprintHash ?? null,
    ],
  );
}
