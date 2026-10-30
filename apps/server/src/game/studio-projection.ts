import { studioSettingsSchema, studioViewSchema, type StudioView } from '@ripple/contracts';

/**
 * Projects the channel's studio inside the snapshot statement, so the studio, round and organism
 * come from one MVCC view. Only finalists and committed or pending results are included; draft
 * proposals contribute a count and nothing else.
 */
export const studioProjectionSql = `(select jsonb_build_object(
  'settings',cs.settings,'availability',cs.availability,'source',cs.availability_source,'bridgeStale',cs.bridge_stale,
  'session',(select jsonb_build_object('id',s.id,'phase',s.phase,'version',s.version,'trigger',s.trigger,'challenge',s.challenge,
    'settings',s.settings,'creationCloseAt',s.creation_close_at,'votingCloseAt',s.voting_close_at,'reviewExpiresAt',s.review_expires_at,
    'shortlist',s.shortlist,'selection',s.selection,'outcome',s.outcome,
    'accepted',(select count(*) from studio_proposals p where p.world_id=s.world_id and p.session_id=s.id and p.status='active'),
    'counts',(select r.checkpoint->'counts' from rounds r where r.world_id=s.world_id and r.id=s.ballot_round_id),
    'blueprints',coalesce((select jsonb_object_agg(b.hash,b.blueprint) from appearance_blueprints b where b.world_id=s.world_id
      and b.hash in (select f->>'hash' from jsonb_array_elements(coalesce(s.shortlist->'finalists','[]'::jsonb)) f)),'{}'::jsonb),
    'pending',(select jsonb_build_object('hash',pa.blueprint_hash,'template',pa.template,'approval',pa.approval,'status',pa.status)
      from pending_adaptations pa where pa.world_id=s.world_id and pa.session_id=s.id))
    from studio_sessions s where s.world_id=cs.world_id and s.channel_id=cs.channel_id
    order by (s.ended_at is null) desc,s.created_at desc limit 1))
  from channel_studio cs where cs.world_id=c.world_id and cs.channel_id=c.id)`;

interface SavedSession {
  id: string;
  phase: string;
  version: number;
  trigger: string;
  challenge: { mutationTemplateIds: string[]; genome: unknown; targetMutationSlot: number };
  settings: { maxProposals: number };
  creationCloseAt: string | null;
  votingCloseAt: string | null;
  reviewExpiresAt: string | null;
  shortlist: { finalists: { hash: string; template: string; credit: string }[] } | null;
  selection: { kind: string; reason: string | null; finalistIndex: number | null } | null;
  outcome: { reason: string } | null;
  accepted: number;
  counts: number[] | null;
  blueprints: Record<string, unknown>;
  pending: {
    hash: string;
    template: string;
    status: string;
    approval: { channelCredit: string; artistCredit: string | null };
  } | null;
}
interface SavedStudio {
  settings: unknown;
  availability: string;
  source: string | null;
  bridgeStale: boolean;
  session: SavedSession | null;
}

const time = (value: string | null): number | null => (value === null ? null : Date.parse(value));

export function projectStudio(saved: unknown): StudioView {
  const studio = saved as SavedStudio;
  const settings = studioSettingsSchema.parse(studio.settings);
  const session = studio.session;
  const pending = session?.pending;
  return studioViewSchema.parse({
    enabled: settings.enabled,
    availability: {
      state: studio.availability,
      source: studio.source,
      bridgeStale: studio.bridgeStale,
    },
    session:
      session === null
        ? null
        : {
            id: session.id,
            phase: session.phase,
            version: session.version,
            trigger: session.trigger,
            cosmeticOnly: session.challenge.mutationTemplateIds.includes('cosmetic-only'),
            challenge: {
              templates: session.challenge.mutationTemplateIds,
              genome: session.challenge.genome,
              targetMutationSlot: session.challenge.targetMutationSlot,
            },
            creationCloseAtMs: time(session.creationCloseAt),
            votingCloseAtMs: time(session.votingCloseAt),
            reviewExpiresAtMs: time(session.reviewExpiresAt),
            accepted: session.accepted,
            maxProposals: session.settings.maxProposals,
            finalists: (session.shortlist?.finalists ?? []).map((finalist, index) => ({
              index: index + 1,
              hash: finalist.hash,
              template: finalist.template,
              blueprint: session.blueprints[finalist.hash],
              credit: finalist.credit,
            })),
            counts: session.counts ?? [],
            selection:
              session.selection === null
                ? null
                : {
                    kind: session.selection.kind,
                    reason: session.selection.reason,
                    finalistIndex: session.selection.finalistIndex,
                  },
            // A pending design is presented as incubating; it claims no change to the creature.
            pending:
              pending?.status !== 'pending'
                ? null
                : {
                    hash: pending.hash,
                    template: pending.template,
                    blueprint: session.blueprints[pending.hash],
                    credit: pending.approval.artistCredit ?? pending.approval.channelCredit,
                    message: 'Community design selected. Hatches after the current round.',
                  },
            outcome: session.outcome,
          },
  });
}
