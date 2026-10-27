import {
  connectionTicketSchema,
  publicUpdateSchema,
  readScopeSchema,
  type PublicUpdate,
} from '@ripple/contracts';

export type TopicStatus =
  'connecting' | 'connected' | 'reconnecting' | 'offline' | 'unauthorized' | 'closed';
export interface ReadSocketHandlers {
  opened: () => void;
  message: (data: unknown) => void;
  closed: () => void;
  failed: () => void;
}
export type ReadSocketFactory = (
  url: string,
  handlers: ReadSocketHandlers,
) => { close: () => void };
export interface ReadTopicOptions {
  baseUrl: string;
  worldId: string;
  channelId: string;
  readCapability: string;
  onUpdate: (update: PublicUpdate) => void;
  onStatus: (status: TopicStatus) => void;
  onServerTime?: (offsetMs: number) => void;
  fetch?: typeof globalThis.fetch;
  createSocket?: ReadSocketFactory;
}
const browserSocket: ReadSocketFactory = (url, handlers) => {
  const socket = new WebSocket(url);
  socket.onopen = handlers.opened;
  socket.onmessage = (event) => {
    handlers.message(event.data);
  };
  socket.onclose = handlers.closed;
  socket.onerror = handlers.failed;
  return {
    close: () => {
      socket.close();
    },
  };
};
/** Read-only browser transport. Every reconnect starts with a newly scoped snapshot. */
export function openReadTopic(options: ReadTopicOptions): { close: () => void } {
  const scope = readScopeSchema.parse({ worldId: options.worldId, channelId: options.channelId });
  const base = new URL(options.baseUrl),
    fetcher = options.fetch ?? globalThis.fetch,
    createSocket = options.createSocket ?? browserSocket;
  let stopped = false,
    offline = typeof window !== 'undefined' && !window.navigator.onLine,
    generation = 0,
    attempt = 0,
    version = -1;
  let socket: ReturnType<ReadSocketFactory> | null = null,
    abort: AbortController | null = null;
  let retry: ReturnType<typeof setTimeout> | undefined,
    watchdog: ReturnType<typeof setTimeout> | undefined;
  let removeListeners: (() => void) | undefined;
  const seen = new Set<string>(),
    order: string[] = [];
  function disconnect(): void {
    generation++;
    clearTimeout(retry);
    clearTimeout(watchdog);
    abort?.abort();
    abort = null;
    const closing = socket;
    socket = null;
    closing?.close();
  }
  function stop(status: TopicStatus): void {
    stopped = true;
    disconnect();
    removeListeners?.();
    options.onStatus(status);
  }
  function reconnect(): void {
    if (stopped || offline) return;
    disconnect();
    options.onStatus('reconnecting');
    const delay = Math.min(30_000, 500 * 2 ** Math.min(attempt++, 6) * (0.8 + 0.4 * Math.random()));
    retry = setTimeout(connect, delay);
  }
  function armWatchdog(): void {
    clearTimeout(watchdog);
    watchdog = setTimeout(reconnect, 45_000);
  }
  function connect(): void {
    if (stopped || offline) return;
    disconnect();
    const current = generation;
    abort = new AbortController();
    options.onStatus(attempt === 0 ? 'connecting' : 'reconnecting');
    void fetcher(new URL('/api/overlay/exchange', base), {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${options.readCapability}`,
      },
      credentials: 'omit',
      cache: 'no-store',
      body: JSON.stringify(scope),
      signal: abort.signal,
    })
      .then(async (response) => {
        if (stopped || current !== generation) return;
        if (response.status === 401 || response.status === 403) {
          stop('unauthorized');
          return;
        }
        if (!response.ok) throw new Error('Read exchange unavailable.');
        const ticket = connectionTicketSchema.parse(await response.json());
        if (current !== generation) return;
        const url = new URL('/api/live', base);
        url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
        url.searchParams.set('ticket', ticket.ticket);
        let snapshotReceived = false;
        socket = createSocket(url.toString(), {
          opened: () => {
            if (current === generation) armWatchdog();
          },
          failed: () => {
            if (current === generation) reconnect();
          },
          closed: () => {
            if (current === generation) reconnect();
          },
          message: (data) => {
            if (stopped || current !== generation) return;
            if (
              typeof data !== 'string' ||
              data.length > 128 * 1024 ||
              new TextEncoder().encode(data).byteLength > 128 * 1024
            ) {
              reconnect();
              return;
            }
            let value: unknown;
            try {
              value = JSON.parse(data);
            } catch {
              reconnect();
              return;
            }
            const parsed = publicUpdateSchema.safeParse(value);
            if (!parsed.success) {
              reconnect();
              return;
            }
            const update = parsed.data;
            if (update.worldId !== scope.worldId || update.topic !== `channel:${scope.channelId}`) {
              reconnect();
              return;
            }
            armWatchdog();
            if (!snapshotReceived && update.type !== 'snapshot') {
              reconnect();
              return;
            }
            if (update.type === 'heartbeat') {
              options.onServerTime?.(Date.parse(update.serverTime) - Date.now());
              return;
            }
            if (update.type === 'snapshot') {
              if (update.stateVersion < version) {
                reconnect();
                return;
              }
              snapshotReceived = true;
              version = update.stateVersion;
              attempt = 0;
              seen.clear();
              order.length = 0;
              options.onStatus('connected');
              options.onServerTime?.(Date.parse(update.serverTime) - Date.now());
            } else {
              if (seen.has(update.eventId) || update.stateVersion <= version) return;
              if (update.stateVersion !== version + 1) {
                reconnect();
                return;
              }
              version = update.stateVersion;
            }
            seen.add(update.eventId);
            order.push(update.eventId);
            if (order.length > 256) {
              const oldest = order.shift();
              if (oldest !== undefined) seen.delete(oldest);
            }
            options.onUpdate(update);
          },
        });
      })
      .catch(() => {
        if (!stopped && current === generation) reconnect();
      });
  }
  if (typeof window !== 'undefined') {
    const onOffline = () => {
      offline = true;
      disconnect();
      options.onStatus('offline');
    };
    const onOnline = () => {
      offline = false;
      connect();
    };
    window.addEventListener('offline', onOffline);
    window.addEventListener('online', onOnline);
    removeListeners = () => {
      window.removeEventListener('offline', onOffline);
      window.removeEventListener('online', onOnline);
    };
  }
  if (offline) options.onStatus('offline');
  else connect();
  return {
    close: () => {
      if (!stopped) stop('closed');
    },
  };
}
