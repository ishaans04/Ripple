import { useEffect, useState } from 'react';
import { CELEBRATION_VISIBLE_MS, type ChannelView } from '@ripple/contracts';

/**
 * Returns a celebration only when it arrives while connected, for a few seconds. The first
 * snapshot after loading or reconnecting is a baseline, so an older celebration never replays.
 */
export function useFreshCelebration(channel: ChannelView | null) {
  const celebration = channel?.celebration ?? null,
    key = celebration === null ? null : `${celebration.kind}:${celebration.atMs}`,
    [baseline, setBaseline] = useState<string | null | undefined>(undefined),
    [active, setActive] = useState<string | null>(null);
  if (channel === null && baseline !== undefined) setBaseline(undefined);
  else if (channel !== null && baseline === undefined) setBaseline(key);
  else if (channel !== null && key !== baseline) {
    setBaseline(key);
    if (key !== null) setActive(key);
  }
  useEffect(() => {
    if (active === null) return;
    const timer = setTimeout(() => {
      setActive(null);
    }, CELEBRATION_VISIBLE_MS);
    return () => {
      clearTimeout(timer);
    };
  }, [active]);
  return active !== null && active === key ? celebration : null;
}
