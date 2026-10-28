import { describe, expect, it } from 'vitest';
import { outgoingRaidDestination } from './raid.ts';
describe('outgoing raid normalization', () => {
  it('accepts only the subscribed source and never turns audience size into power', () => {
    const event = { from_broadcaster_user_id: '123', to_broadcaster_user_id: '456', viewers: 1 };
    expect(outgoingRaidDestination(event, '123')).toBe('456');
    expect(outgoingRaidDestination({ ...event, viewers: 9001 }, '123')).toBe('456');
    expect(outgoingRaidDestination(event, '456')).toBeNull();
    expect(outgoingRaidDestination({ ...event, viewers: -1 }, '123')).toBeNull();
  });
});
