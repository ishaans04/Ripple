import { describe, expect, it } from 'vitest';
import { normalizeChat } from './chat.ts';
const scope = {
  worldId: 'world',
  channelId: 'channel',
  twitchId: '123',
  botId: '999',
  actorSecret: Buffer.alloc(32, 1).toString('base64'),
};
const event = {
  broadcaster_user_id: '123',
  chatter_user_id: '456',
  message_id: 'one',
  message: { text: 'hello' },
  message_type: 'text',
  source_broadcaster_user_id: null,
  source_message_id: null,
};
describe('local chat normalization', () => {
  it('keeps only semantic vote/activity data and excludes bot feedback and invalid commands', () => {
    const normalized = normalizeChat({ ...event, message: { text: ' !ripple 2 ' } }, scope);
    expect(normalized?.intent).toMatchObject({ action: 'vote', choice: 2 });
    expect(JSON.stringify(normalized)).not.toContain('456');
    expect(JSON.stringify(normalized)).not.toContain('!ripple');
    expect(normalizeChat({ ...event, chatter_user_id: '999' }, scope)).toBeNull();
    for (const text of ['!ripple 4', '!ripple 1 and 2', '!ripple', '!ripple nonsense', ''])
      expect(normalizeChat({ ...event, message: { text } }, scope)).toBeNull();
    expect(normalizeChat({ ...event, message: { text: '!ripple help' } }, scope)?.intent).toBe(
      'help',
    );
  });
  it('accepts a local source once and rejects mirrored and incomplete Shared Chat fields', () => {
    expect(
      normalizeChat(
        { ...event, source_broadcaster_user_id: '123', source_message_id: 'origin' },
        scope,
      )?.semanticId,
    ).toBe('channel:origin');
    expect(
      normalizeChat(
        { ...event, source_broadcaster_user_id: '789', source_message_id: 'origin' },
        scope,
      ),
    ).toBeNull();
    expect(normalizeChat({ ...event, source_broadcaster_user_id: '123' }, scope)).toBeNull();
    expect(normalizeChat({ ...event, source_message_id: 'origin' }, scope)).toBeNull();
    expect(normalizeChat({ ...event, broadcaster_user_id: '789' }, scope)).toBeNull();
  });
});
