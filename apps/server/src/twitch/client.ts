import { z } from 'zod';
import type { TwitchConfig } from './security.ts';

const tokenSchema = z.object({
  access_token: z.string().min(1),
  refresh_token: z.string().min(1).optional(),
  expires_in: z.int().positive(),
  scope: z.array(z.string()).optional(),
});
export type ProviderTokens = z.infer<typeof tokenSchema>;
const validationSchema = z.object({
  client_id: z.string(),
  user_id: z.string().optional(),
  login: z.string().optional(),
  scopes: z.array(z.string()),
  expires_in: z.int().nonnegative(),
});
export type ValidatedToken = z.infer<typeof validationSchema>;
export class TwitchError extends Error {
  readonly status: number;
  readonly code:
    | 'PROVIDER_UNAVAILABLE'
    | 'GRANT_REVOKED'
    | 'RATE_LIMITED'
    | 'PROVIDER_REJECTED'
    | 'INVALID_RESPONSE';
  constructor(
    status: number,
    code:
      | 'PROVIDER_UNAVAILABLE'
      | 'GRANT_REVOKED'
      | 'RATE_LIMITED'
      | 'PROVIDER_REJECTED'
      | 'INVALID_RESPONSE',
  ) {
    super(code);
    this.status = status;
    this.code = code;
    this.name = 'TwitchError';
  }
}
/** No provider response bodies, request URLs or credentials are attached to errors. */
export class TwitchClient {
  readonly config: TwitchConfig;
  private readonly transport: typeof fetch;
  private cachedApp: { access: string; until: number } | undefined;
  private appPending: Promise<string> | undefined;
  constructor(config: TwitchConfig, transport: typeof fetch = fetch) {
    this.config = config;
    this.transport = transport;
  }
  private async request(url: string, init: RequestInit): Promise<unknown> {
    let response: Response;
    try {
      response = await this.transport(url, {
        ...init,
        redirect: 'error',
        signal: AbortSignal.timeout(8000),
      });
    } catch {
      throw new TwitchError(503, 'PROVIDER_UNAVAILABLE');
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new TwitchError(
        response.status,
        response.status === 401
          ? 'GRANT_REVOKED'
          : response.status === 429
            ? 'RATE_LIMITED'
            : response.status >= 500
              ? 'PROVIDER_UNAVAILABLE'
              : 'PROVIDER_REJECTED',
      );
    }
    if (response.status === 204) return undefined;
    // Bounded streamed response: a malicious/incorrect upstream cannot allocate unbounded JSON.
    const reader = response.body?.getReader();
    if (reader === undefined) throw new TwitchError(502, 'INVALID_RESPONSE');
    let size = 0;
    const chunks: Uint8Array[] = [];
    try {
      for (;;) {
        const part = await reader.read();
        if (part.done) break;
        size += part.value.length;
        if (size > 1024 * 1024) {
          await reader.cancel();
          throw new Error('limit');
        }
        chunks.push(part.value);
      }
      return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
    } catch {
      throw new TwitchError(502, 'INVALID_RESPONSE');
    }
  }
  async tokens(parameters: Record<string, string>): Promise<ProviderTokens> {
    const body = new URLSearchParams({
      client_id: this.config.clientId,
      client_secret: this.config.clientSecret,
      ...parameters,
    });
    const value = await this.request('https://id.twitch.tv/oauth2/token', { method: 'POST', body });
    const parsed = tokenSchema.safeParse(value);
    if (!parsed.success) throw new TwitchError(502, 'INVALID_RESPONSE');
    return parsed.data;
  }
  async validate(access: string): Promise<ValidatedToken> {
    const result = validationSchema.safeParse(
      await this.request('https://id.twitch.tv/oauth2/validate', {
        headers: { Authorization: `OAuth ${access}` },
      }),
    );
    if (!result.success) throw new TwitchError(502, 'INVALID_RESPONSE');
    return result.data;
  }
  async appToken(): Promise<string> {
    if (this.cachedApp !== undefined && this.cachedApp.until > Date.now())
      return this.cachedApp.access;
    this.appPending ??= this.tokens({ grant_type: 'client_credentials' })
      .then((token) => {
        this.cachedApp = {
          access: token.access_token,
          until: Date.now() + Math.max(0, token.expires_in - 60) * 1000,
        };
        return token.access_token;
      })
      .finally(() => {
        this.appPending = undefined;
      });
    return this.appPending;
  }
  async helix(
    path: string,
    options: { method?: 'GET' | 'POST' | 'DELETE'; body?: unknown } = {},
  ): Promise<unknown> {
    // Only internal relative Helix paths are accepted; never forward credentials to another origin.
    if (!/^\/[a-z][a-z0-9/]*(\?[^#]*)?$/.test(path)) throw new Error('Invalid Helix path');
    for (let attempt = 0; attempt < 2; attempt++) {
      const access = await this.appToken();
      try {
        return await this.request(`https://api.twitch.tv/helix${path}`, {
          method: options.method ?? 'GET',
          headers: {
            'Client-Id': this.config.clientId,
            Authorization: `Bearer ${access}`,
            'Content-Type': 'application/json',
          },
          ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
        });
      } catch (error) {
        if (!(error instanceof TwitchError) || error.status !== 401 || attempt !== 0) throw error;
        this.cachedApp = undefined;
      }
    }
    throw new TwitchError(503, 'PROVIDER_UNAVAILABLE');
  }
}
