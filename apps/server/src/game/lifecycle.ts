import type { GameCommand, GameResultCode } from '@ripple/contracts';
import {
  interruptRoundClock,
  pauseRoundClock,
  recoverRoundClock,
  resumeRoundClock,
} from '@ripple/engine';
import { gameHeld, saveCheckpoint, type GameContext } from './store.ts';
import { captureFamilyDigest, clearFamilyDigest } from './family-digest.ts';

export interface CommandEffect {
  code: GameResultCode;
  updateType: string | null;
  detail: Readonly<Record<string, unknown>>;
  dependencies?: readonly Readonly<Record<string, unknown>>[];
}
export function effect(
  code: GameResultCode,
  updateType: string | null = null,
  detail: Readonly<Record<string, unknown>> = {},
): CommandEffect {
  return { code, updateType, detail };
}
export async function applyLifecycle(
  context: GameContext,
  command: Extract<
    GameCommand,
    {
      type: 'pause' | 'resume' | 'interrupt' | 'recover' | 'integration' | 'stream' | 'inputHealth';
    }
  >,
  atMs: number,
): Promise<CommandEffect> {
  const { channel, round, client, timings } = context;
  const scope = [channel.world_id, channel.id];
  if (command.type === 'stream' || command.type === 'inputHealth') {
    if (command.type === 'stream' && command.online !== channel.online)
      await (command.online ? captureFamilyDigest(context, atMs) : clearFamilyDigest(context));
    const result = await applyLifecycle(
      context,
      {
        type: 'integration',
        online: command.type === 'stream' ? command.online : channel.online,
        healthy: command.type === 'inputHealth' ? command.healthy : channel.healthy,
      },
      atMs,
    );
    if (
      channel.online &&
      channel.healthy &&
      !gameHeld(channel) &&
      context.round !== null &&
      context.round.checkpoint.clock.phase !== 'INTERRUPTED'
    ) {
      const resumed = await applyLifecycle(context, { type: 'resume' }, atMs);
      if (resumed.code === 'APPLIED') return resumed;
    }
    return result;
  }
  if (command.type === 'integration') {
    const changed = channel.online !== command.online || channel.healthy !== command.healthy;
    await client.query('update channels set online=$3,healthy=$4 where world_id=$1 and id=$2', [
      ...scope,
      command.online,
      command.healthy,
    ]);
    channel.online = command.online;
    channel.healthy = command.healthy;
    if (round !== null) {
      let clock = round.checkpoint.clock;
      if (!command.healthy) clock = interruptRoundClock(clock, atMs, timings);
      else if (!command.online) clock = pauseRoundClock(clock, atMs);
      // Reconciliation never silently resumes an interrupted or manually paused game.
      if (clock !== round.checkpoint.clock)
        await saveCheckpoint(context, { ...round.checkpoint, clock });
    }
    return effect(changed ? 'APPLIED' : 'NO_CHANGE', changed ? 'integration.status' : null);
  }
  if (command.type === 'pause') {
    const flagChanged = command.reason === 'manual' && !channel.paused;
    if (flagChanged) {
      await client.query('update channels set paused=true where world_id=$1 and id=$2', scope);
      channel.paused = true;
    }
    if (round === null)
      return effect(flagChanged ? 'APPLIED' : 'NO_CHANGE', flagChanged ? 'paused' : null, {
        reason: command.reason,
      });
    const clock = pauseRoundClock(round.checkpoint.clock, atMs);
    if (clock === round.checkpoint.clock)
      return effect(flagChanged ? 'APPLIED' : 'NO_CHANGE', flagChanged ? 'paused' : null, {
        reason: command.reason,
      });
    await saveCheckpoint(context, { ...round.checkpoint, clock });
    return effect('APPLIED', 'paused', { reason: command.reason });
  }
  if (command.type === 'interrupt') {
    const flagChanged = channel.healthy;
    await client.query('update channels set healthy=false where world_id=$1 and id=$2', scope);
    channel.healthy = false;
    if (round === null)
      return effect(
        flagChanged ? 'APPLIED' : 'NO_CHANGE',
        flagChanged ? 'integration.status' : null,
        { reason: command.reason },
      );
    const clock = interruptRoundClock(round.checkpoint.clock, atMs, timings);
    if (clock === round.checkpoint.clock)
      return effect(
        flagChanged ? 'APPLIED' : 'NO_CHANGE',
        flagChanged ? 'integration.status' : null,
        { reason: command.reason },
      );
    await saveCheckpoint(context, { ...round.checkpoint, clock });
    await client.query(`update rounds set confidence='interrupted' where world_id=$1 and id=$2`, [
      channel.world_id,
      round.id,
    ]);
    return effect('APPLIED', 'paused', { reason: command.reason, interrupted: true });
  }
  if (!channel.online || !channel.healthy) return effect('INTEGRATION_UNAVAILABLE');
  if (command.type === 'recover' && channel.paused) return effect('PAUSED');
  const flagChanged = command.type === 'resume' && channel.paused;
  if (flagChanged) {
    await client.query('update channels set paused=false where world_id=$1 and id=$2', scope);
    channel.paused = false;
  }
  if (round === null)
    return effect(flagChanged ? 'APPLIED' : 'NO_CHANGE', flagChanged ? 'resumed' : null);
  // A manual resume clears only the manual pause; an undecided studio keeps holding the clock.
  if (channel.studio_hold)
    return effect(flagChanged ? 'APPLIED' : 'NO_CHANGE', flagChanged ? 'resumed' : null, {
      studioHold: true,
    });
  const clock =
    command.type === 'recover'
      ? recoverRoundClock(round.checkpoint.clock, atMs)
      : resumeRoundClock(round.checkpoint.clock, atMs);
  if (clock === round.checkpoint.clock)
    return effect(flagChanged ? 'APPLIED' : 'NO_CHANGE', flagChanged ? 'resumed' : null, {
      recoveryRequired: clock.phase === 'INTERRUPTED',
    });
  await saveCheckpoint(context, { ...round.checkpoint, clock });
  return effect('APPLIED', 'resumed', {
    recovery: command.type === 'recover',
    observationEpoch: clock.observationEpoch,
  });
}
