import { useEffect, useState } from 'react';
import { channelViewSchema, type ChannelView } from '@ripple/contracts';
import { openReadTopic, type TopicStatus } from './read-topic.ts';
import { readLinkFromHash } from './read-link.ts';

/** Shared read-only client; capabilities stay in the fragment and authorized request headers. */
export function useReadChannel() {
  const [channel, setChannel] = useState<ChannelView | null>(null),
    [status, setStatus] = useState<TopicStatus | 'invalid'>('connecting'),
    [serverOffsetMs, setServerOffsetMs] = useState(0);
  useEffect(() => {
    let stopped = false,
      topic: ReturnType<typeof openReadTopic> | undefined;
    function connect() {
      if (stopped) return;
      topic?.close();
      setChannel(null);
      const link = readLinkFromHash(location.hash);
      if (link === null) {
        setStatus('invalid');
        return;
      }
      topic = openReadTopic({
        baseUrl: location.origin,
        worldId: link.worldId,
        channelId: link.channelId,
        readCapability: link.capability,
        onStatus: (next) => {
          if (!stopped) setStatus(next);
        },
        onServerTime: (offset) => {
          if (!stopped) setServerOffsetMs(offset);
        },
        onUpdate: (update) => {
          if (stopped || update.type === 'heartbeat') return;
          const view = channelViewSchema.safeParse(update.payload);
          if (view.success) setChannel(view.data);
          else {
            topic?.close();
            setChannel(null);
            setStatus('invalid');
          }
        },
      });
    }
    queueMicrotask(connect);
    window.addEventListener('hashchange', connect);
    return () => {
      stopped = true;
      window.removeEventListener('hashchange', connect);
      topic?.close();
    };
  }, []);
  return { channel, status, serverOffsetMs };
}
