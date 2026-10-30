import { randomUUID } from 'node:crypto';
import type { GameCommand } from '@ripple/contracts';
import type { CommandEffect } from './lifecycle.ts';
import type { GameContext } from './store.ts';

/** Server events from PRD section 20 and addendum section 28; client events arrive separately. */
export const serverAnalyticsEvents = [
  'strain_seeded',
  'ballot_opened',
  'vote_accepted',
  'round_resolved',
  'raid_received',
  'child_admitted',
  'welcome_completed',
  'trace_offered',
  'trace_kept',
  'trace_cleared',
  'trace_expired',
  'dormant_captured',
  'dormant_offered',
  'dormant_activated',
  'host_returned',
  'studio_triggered',
  'studio_opened',
  'proposal_submitted',
  'shortlist_published',
  'studio_vote_accepted',
  'proposal_approved',
  'proposal_rejected',
  'adaptation_hatched',
  'inherited_blueprint_seen',
  'sandbox_completed',
] as const;
export const clientAnalyticsEvents = [
  'onboarding_started',
  'onboarding_completed',
  'overlay_seen',
  'trial_opened',
  'passport_opened',
  'editor_opened',
  'camera_enabled',
  'camera_failed',
  'fallback_selected',
] as const;
export type AnalyticsEvent =
  (typeof serverAnalyticsEvents)[number] | (typeof clientAnalyticsEvents)[number];
type Aggregates = Readonly<Record<string, string | number | boolean | null>>;

/** Maps one committed effect to product events. Values are counts and kinds, never identities. */
export function analyticsFor(
  command: GameCommand,
  result: CommandEffect,
  context: Pick<GameContext, 'round'>,
  previous: { online: boolean },
  online: boolean,
): { type: AnalyticsEvent; aggregates: Aggregates }[] {
  const events: { type: AnalyticsEvent; aggregates: Aggregates }[] = [];
  const detail = result.detail;
  if (command.type === 'stream' && command.online && !previous.online && online)
    events.push({ type: 'host_returned', aggregates: {} });
  if (
    command.type === 'studioStart' ||
    (command.type === 'bridgeScene' &&
      (result.updateType === 'studio.opened' || detail.availability === 'REST'))
  )
    if (result.code === 'APPLIED')
      events.push({
        type: 'studio_triggered',
        aggregates: { trigger: command.type === 'studioStart' ? command.trigger : 'bridge' },
      });
  if (result.code !== 'APPLIED') return events;
  const outcome = typeof detail.outcome === 'string' ? detail.outcome : null;
  if (command.type === 'arrive' || command.type === 'claimRaid') {
    events.push({
      type: 'raid_received',
      aggregates: { outcome, historical: command.type === 'claimRaid' },
    });
    if (result.updateType === 'visitor.arrived')
      events.push({ type: 'child_admitted', aggregates: { outcome } });
  }
  if (command.type === 'seed') events.push({ type: 'strain_seeded', aggregates: {} });
  switch (result.updateType ?? 'none') {
    case 'ballot.opened': {
      const special = context.round?.checkpoint.specialBallot?.kind ?? null;
      events.push({
        type: 'ballot_opened',
        aggregates: {
          kind:
            special ?? (context.round?.checkpoint.studioHatch === undefined ? 'MUTATION' : 'HATCH'),
        },
      });
      if (special === 'TRACE') events.push({ type: 'trace_offered', aggregates: {} });
      if (context.round?.checkpoint.dormantOffer !== undefined)
        events.push({
          type: 'dormant_offered',
          aggregates: {
            withDesign: context.round.checkpoint.dormantOffer.blueprintHash !== undefined,
          },
        });
      break;
    }
    case 'vote.aggregate':
      events.push({
        type: detail.studio === true ? 'studio_vote_accepted' : 'vote_accepted',
        aggregates: {},
      });
      break;
    case 'ballot.closed':
      if (detail.kind === 'WELCOME')
        events.push({
          type: 'welcome_completed',
          aggregates: {
            choice: String(detail.choiceId),
            votes: Array.isArray(detail.counts)
              ? (detail.counts as number[]).reduce((a, b) => a + b, 0)
              : 0,
          },
        });
      if (detail.kind === 'TRACE')
        events.push({
          type: detail.choiceId === 'keep' ? 'trace_kept' : 'trace_cleared',
          aggregates: {},
        });
      if (detail.dormant !== undefined)
        events.push({ type: 'dormant_captured', aggregates: { studio: false } });
      if (typeof detail.dormantConsumed === 'string' && context.round !== null) {
        const card = context.round.checkpoint.candidates.find((item) => item.source === 'dormant');
        if (card !== undefined && card.id === detail.choiceId)
          events.push({
            type: 'dormant_activated',
            aggregates: { withDesign: typeof detail.dormantDesign === 'string' },
          });
      }
      break;
    case 'round.resolved':
    case 'contest.resolved':
    case 'strain.fossilized': {
      const resolution = detail.resolution as
        { outcome?: string; profile?: { confidence?: string } } | undefined;
      events.push({
        type: 'round_resolved',
        aggregates: {
          outcome: resolution?.outcome ?? null,
          confidence: resolution?.profile?.confidence ?? null,
        },
      });
      break;
    }
    case 'studio.opened':
      events.push({
        type: 'studio_opened',
        aggregates: {
          cosmeticOnly:
            Array.isArray(detail.templates) && detail.templates.includes('cosmetic-only'),
        },
      });
      break;
    case 'studio.proposals_changed':
      if (command.type === 'studioProposal')
        events.push({
          type: 'proposal_submitted',
          aggregates: {
            replacement: detail.replaced !== null,
            inputMode: command.inputMode ?? 'unknown',
          },
        });
      break;
    case 'studio.shortlist_ready':
      events.push({
        type: 'shortlist_published',
        aggregates: { finalists: Array.isArray(detail.finalists) ? detail.finalists.length : 0 },
      });
      break;
    case 'studio.adaptation_pending':
      events.push({
        type: 'proposal_approved',
        aggregates: { automatic: command.type === 'studioDeadline' },
      });
      break;
    case 'studio.cancelled':
      // Only a review decision is a rejection; closures and failed revalidation are not.
      if (command.type === 'studioReview')
        events.push({ type: 'proposal_rejected', aggregates: { reason: String(detail.reason) } });
      break;
    case 'appearance.committed':
      events.push({ type: 'adaptation_hatched', aggregates: {} });
      break;
    default:
      break;
  }
  if (
    command.type === 'studioDeadline' &&
    typeof (detail.selection as { dormantId?: unknown } | undefined)?.dormantId === 'string'
  )
    events.push({ type: 'dormant_captured', aggregates: { studio: true } });
  return events;
}

export async function recordAnalytics(
  context: GameContext,
  mode: string | undefined,
  result: CommandEffect,
  mapped: readonly { type: AnalyticsEvent; aggregates: Aggregates }[],
): Promise<void> {
  // Replays reconstruct history; they never count as new product activity.
  if (mode === 'replay') return;
  const events = [...mapped];
  if (Array.isArray(result.detail.tracesAged)) {
    const ids = result.detail.tracesAged.filter((id): id is string => typeof id === 'string');
    const expired = await context.client.query(
      "select id from habitat_traces where world_id=$1 and id=any($2::uuid[]) and status='expired'",
      [context.channel.world_id, ids],
    );
    events.push(...expired.rows.map(() => ({ type: 'trace_expired' as const, aggregates: {} })));
  }
  if (result.updateType === 'visitor.arrived' && typeof result.detail.childId === 'string') {
    const inherited = await context.client.query(
      'select 1 from organisms where world_id=$1 and id=$2 and appearance_hash is not null',
      [context.channel.world_id, result.detail.childId],
    );
    if (inherited.rowCount === 1) events.push({ type: 'inherited_blueprint_seen', aggregates: {} });
  }
  if (events.length === 0) return;
  for (const event of events)
    await context.client.query(
      'insert into analytics_events(world_id,channel_id,id,type,aggregates) values($1,$2,$3,$4,$5)',
      [
        context.channel.world_id,
        context.channel.id,
        randomUUID(),
        event.type,
        JSON.stringify({ ...event.aggregates, sandbox: mode === 'sandbox' }),
      ],
    );
}
