import { resolve } from 'node:path';
import pg from 'pg';
import { buildApp } from '../apps/server/src/app.ts';
import { browserTestPort } from './browser-config.ts';

// Uses the actual app and production assets. Studio practice requires no database I/O.
const pool = new pg.Pool({ connectionString: 'postgres://unused@127.0.0.1:1/unused' });
const app = await buildApp({
  config: { logLevel: 'silent', webRoot: resolve('apps/web/dist') },
  pool,
});
app.addHook('onClose', () => pool.end());
for (const signal of ['SIGTERM', 'SIGINT'] as const)
  process.on(signal, () => {
    void app.close();
  });
await app.listen({ host: '127.0.0.1', port: browserTestPort });
