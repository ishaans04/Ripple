import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import { createShutdown } from './shutdown.ts';

describe('createShutdown', () => {
  it('closes the app, runs close hooks, then exits with the requested code', async () => {
    const app = Fastify();
    const order: string[] = [];
    app.addHook('onClose', () => {
      order.push('release resources');
      return Promise.resolve();
    });
    const exit = vi.fn((code: number) => order.push(`exit ${code}`));

    await createShutdown({ app, graceMs: 1_000, exit })('SIGTERM');
    expect(order).toEqual(['release resources', 'exit 0']);
  });

  it('forces exit when draining exceeds the grace period', async () => {
    const app = Fastify();
    let release: () => void = () => undefined;
    app.addHook('onClose', () => new Promise<void>((resolve) => (release = resolve)));
    const exit = vi.fn();

    const pending = createShutdown({ app, graceMs: 20, exit })('SIGTERM');
    await vi.waitFor(() => {
      expect(exit).toHaveBeenCalledWith(1);
    });
    release();
    await pending;
  });

  it('forces exit on a second request while draining', async () => {
    const app = Fastify();
    let release: (() => void) | undefined;
    app.addHook('onClose', () => new Promise<void>((resolve) => (release = resolve)));
    const exit = vi.fn();
    const shutdown = createShutdown({ app, graceMs: 1_000, exit });

    const first = shutdown('SIGTERM');
    await vi.waitFor(() => {
      expect(release).toBeDefined();
    });
    await shutdown('SIGINT');
    expect(exit).toHaveBeenCalledWith(1);
    release?.();
    await first;
  });

  it('propagates a failure exit code for fatal errors', async () => {
    const app = Fastify();
    const exit = vi.fn();
    await createShutdown({ app, graceMs: 1_000, exit })('uncaughtException', 1);
    expect(exit).toHaveBeenCalledWith(1);
  });
});
