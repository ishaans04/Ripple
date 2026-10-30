import pg from 'pg';
import { z } from 'zod';
import { processNextInput } from '../game/worker.ts';
const connection = z.url().parse(process.env.DATABASE_URL);
if (!/^\/ripple_test_[a-f0-9]{12}$/.test(new URL(connection).pathname))
  throw new Error('Crash worker requires an isolated release fixture database');
const pool = new pg.Pool({ connectionString: connection, max: 1 });
pool.on('error', () => undefined);
await processNextInput(
  pool,
  z.uuid().parse(process.env.CRASH_WORLD),
  z.uuid().parse(process.env.CRASH_CHANNEL),
);
// No explicit publication wake or external success response can occur after this commit.
process.kill(process.pid, 'SIGKILL');
