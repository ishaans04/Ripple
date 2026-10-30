import { expect, it } from 'vitest';
import {
  candidateRuleset,
  rulesetCanonicalJson,
  rulesetHash,
  canonicalJson,
  sha256Hex,
} from '@ripple/engine';
import { verifyAcceptedWorld, type WorldReplay } from './world-replay.ts';
import type { ChannelReplay, AcceptedRecord } from './replay.ts';
import { syntheticTimings } from './sandbox.ts';
const first = '11111111-1111-4111-8111-111111111111',
  second = '22222222-2222-4222-8222-222222222222';
function channel(id: string, dependencies: unknown[]): ChannelReplay {
  const material = {
    previousChecksum: '0'.repeat(64),
    engineVersion: 1,
    rulesHash: rulesetHash(candidateRuleset),
    sequence: 1,
    operationId: 'synthetic:receipt',
    acceptedAtMs: 1000,
    command: { type: 'resume' } as const,
    result: { code: 'NO_CHANGE' as const, updateType: null, detail: {} },
    dependencies,
  };
  const checksum = sha256Hex(canonicalJson(material));
  const record: AcceptedRecord = {
    ...material,
    checksum,
    provider: 'synthetic',
    messageId: 'receipt',
  };
  return {
    schemaVersion: 1,
    channelId: id,
    label: 'Synthetic verification fixture',
    seed: 'fixture',
    timings: syntheticTimings,
    rulesCanonical: rulesetCanonicalJson(candidateRuleset),
    rulesHash: material.rulesHash,
    initialOnline: true,
    initialHealthy: true,
    initialPaused: false,
    checksum,
    records: [record],
  };
}
const world = (dependencies: unknown[]): WorldReplay => ({
  schemaVersion: 1,
  sourceWorldId: first,
  channels: [channel(first, dependencies), channel(second, [])],
});
it('offline verification refuses missing histories and unsupported dependency types', () => {
  expect(() => {
    verifyAcceptedWorld({ schemaVersion: 1, sourceWorldId: first, channels: [] });
  }).toThrow('no channel histories');
  expect(() => {
    verifyAcceptedWorld(world([{ channelId: second, unsupported: true }]));
  }).toThrow('Unknown cross-channel');
});
it('offline verification checks dependency bounds even when checksum chains are valid', () => {
  expect(() => {
    verifyAcceptedWorld(world([{ channelId: second, sequence: 2 }]));
  }).toThrow('outside the exported');
  expect(() => {
    verifyAcceptedWorld(world([{ channelId: second, processedSequence: 2, intakeSequence: 1 }]));
  }).toThrow('outside the exported');
  expect(() => {
    verifyAcceptedWorld(world([{ channelId: second, processedSequence: 0, intakeSequence: 2 }]));
  }).toThrow('outside the exported');
  expect(() => {
    verifyAcceptedWorld(world([{ channelId: second, processedSequence: 0, intakeSequence: 1 }]));
  }).not.toThrow();
});
