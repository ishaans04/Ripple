import { defineConfig } from 'vitest/config';
import { availableParallelism } from 'node:os';

const sourceConditions = ['ripple-source'];

export default defineConfig({
  resolve: { conditions: sourceConditions },
  ssr: { resolve: { conditions: sourceConditions, externalConditions: sourceConditions } },
  test: {
    projects: [
      {
        extends: true,
        test: {
          name: 'unit',
          maxWorkers: Math.min(4, availableParallelism()),
          include: ['{packages,apps}/*/src/**/*.test.{ts,tsx}'],
          exclude: ['**/*.integration.test.ts'],
        },
      },
      {
        // Integration tests run against a real PostgreSQL database (DATABASE_URL).
        extends: true,
        test: {
          name: 'integration',
          // Database creation and the complete migration set are fixture setup, not request latency.
          hookTimeout: 30_000,
          // Full-flow journeys issue dozens of ordered transactions; wall-clock time is not what
          // they verify, so they share one bound instead of per-test limits tuned to one machine.
          // Request-latency assertions inside tests are unchanged.
          testTimeout: 60_000,
          include: ['{packages,apps}/*/src/**/*.integration.test.ts'],
          fileParallelism: false,
        },
      },
    ],
  },
});
