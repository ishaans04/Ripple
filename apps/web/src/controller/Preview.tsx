import { useReadChannel } from '../realtime/useReadChannel.ts';
import { ChannelCard } from './ChannelCard.tsx';
import { readLinkFromHash } from '../realtime/read-link.ts';
import styles from './Controller.module.css';
export default function Preview() {
  const { channel, status } = useReadChannel();
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
      {channel !== null && (
        <>
          <ChannelCard
            channel={channel}
            worldId={readLinkFromHash(location.hash)?.worldId ?? null}
          />
          <a href={`/lineage${location.hash}`}>Open lineage map and passports</a>
        </>
      )}
    </main>
  );
}
