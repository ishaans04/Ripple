import helmet from '@fastify/helmet';
import fastifyStatic from '@fastify/static';
import type { FastifyInstance } from 'fastify';
import { pathOf } from './logging.ts';

/**
 * Security headers for every response. Pages load only same-origin code, and
 * no-referrer keeps capability-bearing URLs from leaking to other sites.
 */
export async function registerSecurityHeaders(app: FastifyInstance): Promise<void> {
  await app.register(helmet, {
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'"],
        imgSrc: ["'self'", 'data:'],
        connectSrc: ["'self'"],
        fontSrc: ["'self'"],
        objectSrc: ["'none'"],
        baseUri: ["'none'"],
        formAction: ["'self'"],
        frameAncestors: ["'none'"],
        // Local evaluation runs over plain HTTP; HSTS covers HTTPS deployments.
        upgradeInsecureRequests: null,
      },
    },
    referrerPolicy: { policy: 'no-referrer' },
  });
  app.addHook('onSend', async (request, reply, payload) => {
    const path = pathOf(request.url);
    const studio = path === '/studio';
    const trackingWorker = /^\/assets\/hand-worker-[A-Za-z0-9_-]+\.js$/.test(path);
    reply.header(
      'permissions-policy',
      studio ? 'camera=(self), microphone=()' : 'camera=(), microphone=()',
    );
    if (studio || trackingWorker) {
      const policy = reply.getHeader('content-security-policy');
      if (typeof policy === 'string')
        reply.header(
          'content-security-policy',
          policy.replace("script-src 'self'", "script-src 'self' 'wasm-unsafe-eval'") +
            ";worker-src 'self'",
        );
    }
    return payload;
  });
}

/** Serve the built web application. Fingerprinted assets are cached permanently. */
export async function registerWebApp(app: FastifyInstance, webRoot: string): Promise<void> {
  await app.register(fastifyStatic, {
    root: webRoot,
    wildcard: false,
    setHeaders: (reply, filePath) => {
      const fingerprinted = /[\\/]assets[\\/]/.test(filePath);
      reply.header(
        'cache-control',
        fingerprinted ? 'public, max-age=31536000, immutable' : 'no-cache',
      );
    },
  });
  app.get('/studio', (_request, reply) => reply.sendFile('index.html'));
  app.get('/controller', (_request, reply) => reply.sendFile('index.html'));
  app.get('/preview', (_request, reply) => reply.sendFile('index.html'));
}
