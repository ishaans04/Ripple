import { describe, expect, it } from 'vitest';
import {
  bridgeReportSchema,
  defaultStudioSettings,
  proposalSubmissionSchema,
  studioSettingsSchema,
} from './studio-session.ts';
import { gameCommandSchema } from './game.ts';
import { founderShell } from './studio.ts';

describe('studio session contracts', () => {
  it('keeps the studio off by default and rejects overlapping or unbounded settings', () => {
    expect(studioSettingsSchema.parse(defaultStudioSettings).enabled).toBe(false);
    expect(
      studioSettingsSchema.safeParse({
        ...defaultStudioSettings,
        breakScenes: ['BRB'],
        activeScenes: ['BRB'],
      }).success,
    ).toBe(false);
    for (const change of [
      { creationMs: 1 },
      { reviewMs: 7_200_000 },
      { maxProposals: 0 },
      { breakScenes: ['line\nbreak'] },
      { breakScenes: Array.from({ length: 9 }, (_, i) => `scene ${i}`) },
      { approval: 'always' },
    ])
      expect(studioSettingsSchema.safeParse({ ...defaultStudioSettings, ...change }).success).toBe(
        false,
      );
  });
  it('limits the OBS bridge to scene, heartbeat and hidden signals with nothing extra', () => {
    expect(bridgeReportSchema.parse({ kind: 'scene', scene: 'Be right back' })).toEqual({
      kind: 'scene',
      scene: 'Be right back',
    });
    for (const value of [
      { kind: 'scene', scene: 'BRB', genes: { grit: 15 } },
      { kind: 'approve' },
      { kind: 'heartbeat' },
      { kind: 'hidden', channelId: '00000000-0000-4000-8000-000000000001' },
    ])
      expect(bridgeReportSchema.safeParse(value).success).toBe(false);
  });
  it('accepts only declarative blueprints as proposals, never markup or resulting genes', () => {
    const blueprint = {
      schemaVersion: 1,
      worldId: '00000000-0000-4000-8000-000000000001',
      studioSessionId: '00000000-0000-4000-8000-000000000002',
      baseOrganismId: '00000000-0000-4000-8000-000000000003',
      baseOrganismVersion: 0,
      mutationTemplateId: 'grit-plus2-pulse-minus2',
      rendererVersion: 'shell-v1',
      part: founderShell,
    };
    const proposal = {
      proposalId: '00000000-0000-4000-8000-000000000004',
      blueprint,
      creditOptIn: false,
    };
    expect(proposalSubmissionSchema.safeParse(proposal).success).toBe(true);
    for (const value of [
      { ...proposal, blueprint: '<svg onload="alert(1)"/>' },
      { ...proposal, blueprint: { ...blueprint, genome: { grit: 15 } } },
      { ...proposal, artist: 'someone-else' },
    ])
      expect(proposalSubmissionSchema.safeParse(value).success).toBe(false);
  });
  it('accepts studio commands only through the strict ordered command union', () => {
    expect(
      gameCommandSchema.safeParse({
        type: 'studioStart',
        trigger: 'manual',
        sessionId: '00000000-0000-4000-8000-000000000002',
      }).success,
    ).toBe(true);
    expect(
      gameCommandSchema.safeParse({
        type: 'studioReview',
        sessionId: '00000000-0000-4000-8000-000000000002',
        sessionVersion: 3,
        decision: 'approve',
        adaptationId: '00000000-0000-4000-8000-000000000005',
        genome: { grit: 15 },
      }).success,
    ).toBe(false);
  });
});
