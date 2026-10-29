export const browserTestPort = Number(process.env.RIPPLE_E2E_PORT ?? '4179');
if (!Number.isSafeInteger(browserTestPort) || browserTestPort < 1024 || browserTestPort > 65535)
  throw new Error('RIPPLE_E2E_PORT must be an integer from 1024 through 65535.');
export const browserTestUrl = `http://127.0.0.1:${browserTestPort}`;
