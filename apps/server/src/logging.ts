import { randomUUID } from 'node:crypto';
import type { FastifyServerOptions } from 'fastify';
import type { ServerConfig } from './config.ts';

export const requestIdHeader = 'x-request-id';

/** Accept an upstream correlation ID only if it cannot inject structure into logs. */
const acceptableRequestId = /^[A-Za-z0-9._-]{8,128}$/;

export function requestIdFrom(header: string | string[] | undefined): string {
  return typeof header === 'string' && acceptableRequestId.test(header) ? header : randomUUID();
}

/** Query strings can carry OAuth codes and state, so logs record the path only. */
export function pathOf(url: string): string {
  const queryStart = url.indexOf('?');
  return queryStart === -1 ? url : url.slice(0, queryStart);
}

export interface LogDestination {
  write: (line: string) => void;
}

export function loggerOptions(
  level: ServerConfig['logLevel'],
  stream?: LogDestination,
): NonNullable<FastifyServerOptions['logger']> {
  return {
    level,
    ...(stream === undefined ? {} : { stream }),
    serializers: {
      // Headers are deliberately omitted: they carry session cookies and credentials.
      req: (request: { method: string; url: string }) => ({
        method: request.method,
        path: pathOf(request.url),
      }),
      res: (reply: { statusCode: number }) => ({ statusCode: reply.statusCode }),
    },
  };
}
