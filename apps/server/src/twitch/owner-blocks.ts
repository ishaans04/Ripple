import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { z } from 'zod';
import { ControlError, ownerSession } from './sessions.ts';
import type { TwitchConfig } from './security.ts';

export function registerOwnerBlocks(
  app: FastifyInstance,
  pool: pg.Pool,
  config: TwitchConfig,
): void {
  app.get('/api/controller/blocks', async (request) => {
    const owner = await ownerSession(pool, request, config);
    const query = z
      .strictObject({ kind: z.enum(['source', 'lineage']), after: z.uuid().optional() })
      .safeParse(request.query);
    if (!query.success) throw new ControlError(400, 'BAD_REQUEST');
    const { kind, after } = query.data;
    const rows = (
      await pool.query<{ id: string; label: string }>(
        kind === 'source'
          ? `select b.source_channel_id as id,c.label from source_blocks b
          join channels c on c.world_id=b.world_id and c.id=b.source_channel_id
          where b.world_id=$1 and b.channel_id=$2 and ($3::uuid is null or b.source_channel_id>$3)
          order by b.source_channel_id limit 51`
          : `select b.lineage_id as id,c.label from lineage_blocks b
          join lineages l on l.world_id=b.world_id and l.id=b.lineage_id
          join channels c on c.world_id=l.world_id and c.id=l.origin_channel_id
          where b.world_id=$1 and b.channel_id=$2 and ($3::uuid is null or b.lineage_id>$3)
          order by b.lineage_id limit 51`,
        [owner.world_id, owner.channel_id, after ?? null],
      )
    ).rows;
    return {
      kind,
      items: rows.slice(0, 50),
      next: rows.length > 50 ? (rows[49]?.id ?? null) : null,
    };
  });
}
