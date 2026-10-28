import { transaction } from '@ripple/database';
import { sha256Hex } from '@ripple/engine';
import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { TwitchClient, TwitchError } from './client.ts';
import { checkIdentity, requiredScopes, storeGrant, type GrantPurpose } from './grants.ts';
import { enrollChannel } from './installation.ts';
import { registerController } from './controller.ts';
import { equalSecret, opaqueToken } from './security.ts';
import { ControlError, cookie, createOwnerSession, requireOrigin, setCookie } from './sessions.ts';

export function registerOAuth(
  app: FastifyInstance,
  pool: pg.Pool,
  api: TwitchClient,
  worldId: string,
): void {
  registerController(app, pool, api.config.origin);
  app.addHook('onRequest', async (_request, reply) => {
    reply.header('Cache-Control', 'no-store');
  });
  app.setErrorHandler((error, _request, reply) => {
    const status =
      error instanceof ControlError
        ? error.status
        : error instanceof TwitchError
          ? error.status === 401
            ? 401
            : 503
          : 500;
    const code =
      error instanceof ControlError
        ? error.code
        : error instanceof TwitchError
          ? error.code
          : 'INTERNAL_ERROR';
    return reply.code(status).send({ error: { code, message: code } });
  });
  async function start(purpose: GrantPurpose, browser: string): Promise<string> {
    const state = opaqueToken();
    await pool.query(
      "insert into oauth_states(hash,browser_hash,world_id,purpose,expires_at) values ($1,$2,$3,$4,clock_timestamp()+interval '10 minutes')",
      [sha256Hex(state), sha256Hex(browser), worldId, purpose],
    );
    const parameters = new URLSearchParams({
      client_id: api.config.clientId,
      redirect_uri: `${api.config.origin}/auth/twitch/callback`,
      response_type: 'code',
      scope: requiredScopes[purpose].join(' '),
      state,
      force_verify: 'true',
    });
    return `https://id.twitch.tv/oauth2/authorize?${parameters}`;
  }
  app.get(
    '/auth/twitch/start',
    { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } },
    async (request, reply) => {
      const browser = cookie(request, '__Host-ripple-state') ?? opaqueToken();
      const url = await start('broadcaster', browser);
      setCookie(reply, '__Host-ripple-state', browser, 600);
      return reply.redirect(url);
    },
  );
  app.post(
    '/auth/twitch/bot/start',
    { config: { rateLimit: { max: 5, timeWindow: '1 minute' } } },
    async (request, reply) => {
      requireOrigin(request, api.config.origin);
      const body = z.strictObject({ operatorSecret: z.string().max(256) }).safeParse(request.body);
      if (!body.success || !equalSecret(body.data.operatorSecret, api.config.operatorSecret))
        throw new ControlError(403, 'OPERATOR_REQUIRED');
      const browser = cookie(request, '__Host-ripple-state') ?? opaqueToken();
      const url = await start('bot', browser);
      setCookie(reply, '__Host-ripple-state', browser, 600);
      return { authorizationUrl: url };
    },
  );
  app.get(
    '/auth/twitch/callback',
    { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } },
    async (request, reply) => {
      const query = z
        .object({
          state: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
          code: z.string().min(1).max(1024).optional(),
          error: z.string().max(256).optional(),
        })
        .safeParse(request.query);
      const browser = cookie(request, '__Host-ripple-state');
      if (!query.success || browser === undefined)
        throw new ControlError(400, 'INVALID_OAUTH_STATE');
      const claimed = (
        await pool.query<{ purpose: GrantPurpose }>(
          `delete from oauth_states where hash=$1 and browser_hash=$2 and world_id=$3 and expires_at>clock_timestamp() returning purpose`,
          [sha256Hex(query.data.state), sha256Hex(browser), worldId],
        )
      ).rows[0];
      if (claimed === undefined) throw new ControlError(400, 'INVALID_OAUTH_STATE');
      if (query.data.error !== undefined || query.data.code === undefined)
        throw new ControlError(400, 'AUTHORIZATION_DENIED');
      const tokens = await api.tokens({
        grant_type: 'authorization_code',
        code: query.data.code,
        redirect_uri: `${api.config.origin}/auth/twitch/callback`,
      });
      const identity = await api.validate(tokens.access_token);
      checkIdentity(identity, api.config, claimed.purpose);
      if (identity.user_id === undefined || identity.login === undefined)
        throw new ControlError(400, 'INVALID_IDENTITY');
      const subject = identity.user_id;
      await transaction(pool, async (client) => {
        const channel =
          claimed.purpose === 'broadcaster'
            ? await enrollChannel(client, worldId, subject, identity.login!)
            : null;
        await storeGrant(client, api.config, worldId, channel, claimed.purpose, tokens, identity);
        if (channel !== null) await createOwnerSession(client, reply, worldId, channel, subject);
      });
      return reply.redirect(
        claimed.purpose === 'bot' ? '/controller?bot=authorized' : '/controller',
      );
    },
  );
  app.post('/auth/logout', async (request, reply) => {
    requireOrigin(request, api.config.origin);
    const raw = cookie(request, '__Host-ripple-session');
    if (raw !== undefined)
      await pool.query('delete from controller_sessions where hash=$1', [sha256Hex(raw)]);
    setCookie(reply, '__Host-ripple-session', '', 0);
    setCookie(reply, '__Host-ripple-csrf', '', 0, false);
    return reply.code(204).send();
  });
}
