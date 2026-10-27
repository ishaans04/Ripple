import { errorResponseSchema } from '@ripple/contracts';
import type { FastifyInstance } from 'fastify';
import pg from 'pg';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from './app.ts';

// These routes never touch the database, so the pool is never connected.
const idlePool = new pg.Pool({ connectionString: 'postgres://unused@127.0.0.1:1/unused' });

describe('application shell', () => {
  let app: FastifyInstance;
  let lines: string[];
  const logs = () => lines.map((line) => JSON.parse(line) as Record<string, unknown>);

  async function start(): Promise<FastifyInstance> {
    lines = [];
    app = await buildApp({
      config: { logLevel: 'info', webRoot: undefined },
      pool: idlePool,
      logStream: { write: (line) => lines.push(line) },
    });
    return app;
  }

  afterEach(async () => {
    await app.close();
  });

  it('echoes a well-formed upstream request id', async () => {
    const response = await (
      await start()
    ).inject({
      url: '/missing',
      headers: { 'x-request-id': 'trace-1234abcd' },
    });
    expect(response.headers['x-request-id']).toBe('trace-1234abcd');
  });

  it('replaces request ids that could inject log structure', async () => {
    const response = await (
      await start()
    ).inject({
      url: '/missing',
      headers: { 'x-request-id': 'bad id\n{"level":"fatal"}' },
    });
    expect(response.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('answers unknown routes with the error contract', async () => {
    const response = await (await start()).inject({ url: '/nothing/here?code=oauth-secret' });
    expect(response.statusCode).toBe(404);
    const body = errorResponseSchema.parse(response.json());
    expect(body.error.code).toBe('NOT_FOUND');
    expect(body.error.message).toBe('No route for GET /nothing/here');
    expect(body.error.requestId).toBe(response.headers['x-request-id']);
  });

  it('hides internal failure details from clients but logs them with the request id', async () => {
    await start();
    app.get('/explode', () => {
      throw new Error('connection to db-internal:5432 refused');
    });
    const response = await app.inject({ url: '/explode' });
    expect(response.statusCode).toBe(500);
    expect(response.body).not.toContain('db-internal');
    expect(errorResponseSchema.parse(response.json()).error.code).toBe('INTERNAL_ERROR');

    const failure = logs().find((entry) => entry.msg === 'request failed');
    expect(failure?.requestId).toBe(response.headers['x-request-id']);
    expect(JSON.stringify(failure)).toContain('db-internal');
  });

  it('reports client errors as BAD_REQUEST', async () => {
    await start();
    app.post('/echo', (request) => request.body);
    const response = await app.inject({
      method: 'POST',
      url: '/echo',
      headers: { 'content-type': 'application/json' },
      payload: '{not json',
    });
    expect(response.statusCode).toBe(400);
    expect(errorResponseSchema.parse(response.json()).error.code).toBe('BAD_REQUEST');
  });

  it('logs request paths without query strings or headers', async () => {
    await (
      await start()
    ).inject({
      url: '/auth/callback?code=oauth-secret&state=abc',
      headers: { cookie: 'session=secret-cookie', authorization: 'Bearer secret-token' },
    });
    const output = JSON.stringify(logs());
    expect(output).toContain('/auth/callback');
    for (const secret of ['oauth-secret', 'secret-cookie', 'secret-token']) {
      expect(output).not.toContain(secret);
    }
  });

  it('sends security headers on every response', async () => {
    const response = await (await start()).inject({ url: '/missing' });
    expect(response.headers['referrer-policy']).toBe('no-referrer');
    expect(response.headers['x-content-type-options']).toBe('nosniff');
    const csp = String(response.headers['content-security-policy']);
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("script-src 'self'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).not.toContain('upgrade-insecure-requests');
  });
});
