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
          include: ['{packages,apps}/*/src/**/*.integration.test.ts'],
          fileParallelism: false,
        },
      },
    ],
  },
});
