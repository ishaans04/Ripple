import { useEffect, useState } from 'react';
import { z } from 'zod';
import { channelViewSchema, type ChannelView } from '@ripple/contracts';
import { openReadTopic, type TopicStatus } from '../realtime/read-topic.ts';
import { ChannelCard } from './ChannelCard.tsx';
import styles from './Controller.module.css';
export default function Preview() {
  const [channel, setChannel] = useState<ChannelView | null>(null),
    [status, setStatus] = useState<TopicStatus | 'invalid'>('connecting');
  useEffect(() => {
    const parsed = z
      .object({
        worldId: z.uuid(),
        channelId: z.uuid(),
        capability: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
      })
      .safeParse(Object.fromEntries(new URLSearchParams(location.hash.slice(1))));
    if (!parsed.success) {
      queueMicrotask(() => {
        setStatus('invalid');
      });
      return;
    }
    const topic = openReadTopic({
      baseUrl: location.origin,
      worldId: parsed.data.worldId,
      channelId: parsed.data.channelId,
      readCapability: parsed.data.capability,
      onStatus: setStatus,
      onUpdate: (update) => {
        if (update.type === 'heartbeat') return;
        const view = channelViewSchema.safeParse(update.payload);
        if (view.success) setChannel(view.data);
        else setStatus('invalid');
      },
    });
    return () => {
      topic.close();
    };
  }, []);
  return (
    <main className={styles.page}>
      <h1>Ripple read-only preview</h1>
      <p role="status">
        {status === 'invalid'
          ? 'The link or renderer state is unsupported. Ask the broadcaster for a new link.'
          : status === 'unauthorized'
            ? 'This link was revoked or expired. Ask the broadcaster for a new link.'
            : `Connection: ${status}`}
      </p>
      {channel !== null && <ChannelCard channel={channel} />}
    </main>
  );
}
