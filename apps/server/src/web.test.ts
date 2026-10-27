import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from './app.ts';

describe('web application serving', () => {
  let webRoot: string;
  let app: FastifyInstance;
  const pool = new pg.Pool({ connectionString: 'postgres://unused@127.0.0.1:1/unused' });

  beforeAll(async () => {
    webRoot = mkdtempSync(join(tmpdir(), 'ripple-web-'));
    writeFileSync(join(webRoot, 'index.html'), '<!doctype html><title>Ripple</title>');
    mkdirSync(join(webRoot, 'assets'));
    writeFileSync(join(webRoot, 'assets', 'index-abc123.js'), 'console.log("ripple")');
    app = await buildApp({ config: { logLevel: 'silent', webRoot }, pool });
  });

  afterAll(async () => {
    await app.close();
    await pool.end();
    rmSync(webRoot, { recursive: true, force: true });
  });

  it('serves the landing document without long-term caching', async () => {
    const response = await app.inject({ url: '/' });
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('text/html');
    expect(response.headers['cache-control']).toBe('no-cache');
    expect(response.body).toContain('<title>Ripple</title>');
  });

  it('caches fingerprinted assets permanently', async () => {
    const response = await app.inject({ url: '/assets/index-abc123.js' });
    expect(response.statusCode).toBe(200);
    expect(response.headers['cache-control']).toBe('public, max-age=31536000, immutable');
  });

  it('allows camera and WASM only on the studio document and tracking worker', async () => {
    const studio = await app.inject({ url: '/studio' });
    expect(studio.statusCode).toBe(200);
    expect(studio.headers['permissions-policy']).toBe('camera=(self), microphone=()');
    expect(studio.headers['content-security-policy']).toContain("'wasm-unsafe-eval'");
    expect(studio.headers['content-security-policy']).toContain("worker-src 'self'");
    const home = await app.inject({ url: '/' });
    expect(home.headers['permissions-policy']).toBe('camera=(), microphone=()');
    expect(home.headers['content-security-policy']).not.toContain('wasm-unsafe-eval');
    const other = await app.inject({ url: '/assets/index-abc123.js' });
    expect(other.headers['content-security-policy']).not.toContain('wasm-unsafe-eval');
  });

  it('keeps API-style 404s for unknown paths', async () => {
    const response = await app.inject({ url: '/assets/missing.js' });
    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ error: { code: 'NOT_FOUND' } });
  });

  it('does not serve files outside the web root', async () => {
    const response = await app.inject({ url: '/../package.json' });
    expect(response.statusCode).toBe(404);
  });
});
