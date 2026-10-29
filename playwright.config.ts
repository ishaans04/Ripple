import { defineConfig, devices } from '@playwright/test';
import { browserTestUrl } from './tests/browser-config.ts';

export default defineConfig({
  testDir: './tests/browser',
  timeout: 60000,
  expect: { timeout: 15000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: 'list',
  use: {
    baseURL: browserTestUrl,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    { name: 'chrome', use: { ...devices['Desktop Chrome'], channel: 'chrome' } },
    { name: 'edge', use: { ...devices['Desktop Edge'], channel: 'msedge' } },
  ],
  webServer: {
    command: 'node --conditions=ripple-source tests/browser-server.ts',
    url: `${browserTestUrl}/studio`,
    timeout: 60000,
    reuseExistingServer: false,
  },
});
