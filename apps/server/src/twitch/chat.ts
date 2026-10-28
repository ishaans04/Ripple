import { z } from 'zod';
import { privateHash } from './security.ts';

const id = z.string().regex(/^[0-9]{1,30}$/);
const chatSchema = z.object({
  broadcaster_user_id: id,
  chatter_user_id: id,
  message_id: z.string().min(1).max(128),
  message: z.object({ text: z.string().max(4096) }),
  message_type: z.string(),
  source_broadcaster_user_id: id.nullish(),
  source_message_id: z.string().min(1).max(128).nullish(),
});
export const chatIntentSchema = z.discriminatedUnion('action', [
  z.strictObject({
    type: z.literal('twitch.chat'),
    actorBase: z.string().regex(/^[0-9a-f]{64}$/),
    action: z.literal('vote'),
    choice: z.int().min(1).max(3),
  }),
  z.strictObject({
    type: z.literal('twitch.chat'),
    actorBase: z.string().regex(/^[0-9a-f]{64}$/),
    action: z.literal('activity'),
  }),
]);
export type ChatIntent = z.infer<typeof chatIntentSchema>;
export function normalizeChat(
  value: unknown,
  scope: {
    worldId: string;
    channelId: string;
    twitchId: string;
    botId: string;
    actorSecret: string;
  },
): { semanticId: string; intent: ChatIntent | 'help' } | null {
  const parsed = chatSchema.safeParse(value);
  if (!parsed.success) return null;
  const event = parsed.data;
  if (event.broadcaster_user_id !== scope.twitchId || event.chatter_user_id === scope.botId)
    return null;
  const source = event.source_broadcaster_user_id,
    sourceId = event.source_message_id;
  // Incomplete Shared Chat metadata is ambiguous; do not manufacture locality.
  if ((source === null || source === undefined) !== (sourceId === null || sourceId === undefined))
    return null;
  if ((source ?? event.broadcaster_user_id) !== scope.twitchId) return null;
  const text = event.message.text.trim();
  if (text.length === 0) return null;
  const semanticId = `${scope.channelId}:${sourceId ?? event.message_id}`;
  if (/^!ripple\s+help\s*$/i.test(text)) return { semanticId, intent: 'help' };
  const vote = /^!ripple\s+([123])\s*$/i.exec(text);
  if (/^!ripple/i.test(text) && vote === null) return null;
  if (vote === null && !['text', 'action'].includes(event.message_type)) return null;
  const actorBase = privateHash(
    scope.actorSecret,
    scope.worldId,
    scope.channelId,
    event.chatter_user_id,
  );
  return {
    semanticId,
    intent:
      vote === null
        ? { type: 'twitch.chat', actorBase, action: 'activity' }
        : { type: 'twitch.chat', actorBase, action: 'vote', choice: Number(vote[1]) },
  };
}
