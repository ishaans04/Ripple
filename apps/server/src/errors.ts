import type { ErrorCode, ErrorResponse } from '@ripple/contracts';
import type { FastifyError, FastifyInstance } from 'fastify';
import { pathOf } from './logging.ts';

export function errorBody(code: ErrorCode, message: string, requestId: string): ErrorResponse {
  return { error: { code, message, requestId } };
}

/** Every failure leaves the server as the uniform error contract. */
export function registerErrorHandling(app: FastifyInstance): void {
  app.setNotFoundHandler((request, reply) => {
    return reply
      .code(404)
      .send(
        errorBody('NOT_FOUND', `No route for ${request.method} ${pathOf(request.url)}`, request.id),
      );
  });

  app.setErrorHandler<FastifyError>((error, request, reply) => {
    const status = error.statusCode ?? 500;
    if (status >= 400 && status < 500) {
      const code: ErrorCode = status === 404 ? 'NOT_FOUND' : 'BAD_REQUEST';
      return reply.code(status).send(errorBody(code, error.message, request.id));
    }
    request.log.error({ err: error }, 'request failed');
    // Internal details stay in the log; clients receive the correlation ID instead.
    return reply.code(500).send(errorBody('INTERNAL_ERROR', 'Internal server error', request.id));
  });
}
