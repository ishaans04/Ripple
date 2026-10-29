import { effect, type CommandEffect } from './lifecycle.ts';
import type { GameContext } from './store.ts';

/** Persist intent only. Current ballot/observation checkpoints retain their captured mechanics. */
export async function requestMechanics(context: GameContext): Promise<CommandEffect> {
  if (context.mechanics.version === 1 || context.mechanics.requested) return effect('NO_CHANGE');
  const changed = await context.client.query(
    'update channel_play set mechanics_requested=true where world_id=$1 and channel_id=$2 and mechanics_version=0 and not mechanics_requested',
    [context.channel.world_id, context.channel.id],
  );
  if (changed.rowCount !== 1) throw new Error('Locked mechanics request changed unexpectedly');
  context.mechanics.requested = true;
  return effect('APPLIED', 'mechanics.requested', { appliesAt: 'next-safe-round-opening' });
}

/** Called by round opening inside the ordered transaction, after its health/pause gates. */
export async function applyRequestedMechanics(context: GameContext): Promise<void> {
  if (!context.mechanics.requested || context.mechanics.version === 1) return;
  if (context.round !== null) throw new Error('Cannot change mechanics inside an existing round');
  if (!context.channel.online || !context.channel.healthy || context.channel.paused)
    throw new Error('Cannot enable mechanics while the channel clock is held');
  const changed = await context.client.query(
    'update channel_play set mechanics_version=1,mechanics_requested=false where world_id=$1 and channel_id=$2 and mechanics_version=0 and mechanics_requested',
    [context.channel.world_id, context.channel.id],
  );
  if (changed.rowCount !== 1) throw new Error('Locked mechanics boundary changed unexpectedly');
  context.mechanics.version = 1;
  context.mechanics.requested = false;
}
