import { parseArgs } from 'node:util';
import { writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { platform, arch, release } from 'node:os';
import { resolve } from 'node:path';
import { z } from 'zod';
import { candidateRuleset, rulesetCanonicalJson, canonicalJson, sha256Hex } from '@ripple/engine';
import { simulateMatrix, simulateTrial } from '../simulator/simulation.ts';
import { summarizeTrials, resultDigest, compareNormalizedSizes } from '../simulator/report.ts';
import { runStudioScenarios, studioScenariosHash } from '../simulator/studio-scenarios.ts';
import { auditPolicies } from '../simulator/adversarial.ts';

try {
  const args = parseArgs({
    options: {
      split: { type: 'string', default: 'held-out' },
      rounds: { type: 'string', default: '36' },
      output: { type: 'string' },
    },
  });
  const split = z.enum(['tuning', 'held-out']).parse(args.values.split);
  const rounds = z.coerce.number().int().min(4).max(120).parse(args.values.rounds);
  const matrix = simulateMatrix(split, rounds);
  let replayDivergences = 0;
  for (const trial of matrix.trials)
    if (simulateTrial(trial.config).historyHash !== trial.historyHash) replayDivergences++;
  const studio = runStudioScenarios();
  const normalizedSizes = compareNormalizedSizes(matrix.trials);
  if (replayDivergences || normalizedSizes.divergences)
    throw new Error('Simulation determinism or audience normalization failed');
  const report = {
    schemaVersion: 1,
    experiment: 'policy-matrix-v1',
    split,
    rounds,
    trials: matrix.trials.length,
    engineRevision: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
    environment: { node: process.version, platform: platform(), arch: arch(), release: release() },
    command: `npm run simulate -- --split ${split} --rounds ${rounds}${args.values.output ? ` --output ${args.values.output}` : ''}`,
    configurationHash: sha256Hex(
      canonicalJson({ split, rounds, seedsHash: matrix.seedsHash, experiment: 'policy-matrix-v1' }),
    ),
    rulesHash: matrix.rulesHash,
    rulesCanonical: rulesetCanonicalJson(candidateRuleset),
    seedsHash: matrix.seedsHash,
    resultsHash: resultDigest(matrix.trials),
    replayDivergences,
    normalizedSizes,
    studioHash: studioScenariosHash(studio),
    studio,
    adversarial: auditPolicies(),
    limitations: [
      'Synthetic bounded policy experiments, not live acceptance or final balance.',
      'Survival at the horizon is right-censored; sparse intervals hold health and are not evidence of fitness.',
      'Arrival mortality includes first-comparison contest loss. Retained branches model a bounded synthetic cohort, not a full multi-host population.',
      'Trace keep/clear compares up to three valid host observations after a child survives qualification; repeated-host emission is not refreshed.',
      'No rule weights were tuned on held-out seeds. Paid-event independence is verified by the server integration suite, not inferred from this pure simulator.',
    ],
    comparisons: summarizeTrials(matrix.trials),
  };
  const json = `${JSON.stringify(report, null, 2)}\n`;
  if (args.values.output) {
    const output = resolve(process.env.INIT_CWD ?? process.cwd(), args.values.output);
    await writeFile(output, json);
    process.stdout.write(
      `Wrote ${matrix.trials.length} trials to ${output}; ${replayDivergences} replay divergences.\n`,
    );
  } else process.stdout.write(json);
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : 'Simulation failed'}\n`);
  process.exitCode = 1;
}
