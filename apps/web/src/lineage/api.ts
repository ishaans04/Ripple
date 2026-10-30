import type { z } from 'zod';
import { lineageCatalogSchema, lineagePageSchema, passportSchema } from '@ripple/contracts';
import type { ReadLink } from '../realtime/read-link.ts';

/** Failures the page explains: a revoked/expired link, an unavailable record, or anything else. */
export class ReadFailure extends Error {
  readonly kind: 'unauthorized' | 'unavailable' | 'failed';
  constructor(kind: ReadFailure['kind']) {
    super(kind);
    this.kind = kind;
  }
}

async function read<T>(link: ReadLink, path: string, schema: z.ZodType<T>, query = '') {
  const scope = new URLSearchParams({ worldId: link.worldId, channelId: link.channelId });
  let response: Response;
  try {
    response = await fetch(`${path}?${scope}${query}`, {
      headers: { authorization: `Bearer ${link.capability}` },
      cache: 'no-store',
    });
  } catch {
    throw new ReadFailure('failed');
  }
  if (response.status === 401) throw new ReadFailure('unauthorized');
  if (response.status === 404) throw new ReadFailure('unavailable');
  if (!response.ok) throw new ReadFailure('failed');
  const parsed = schema.safeParse(await response.json());
  if (!parsed.success) throw new ReadFailure('failed');
  return parsed.data;
}

export const readCatalog = (link: ReadLink, after: string | null) =>
  read(
    link,
    '/api/lineages',
    lineageCatalogSchema,
    after === null ? '' : `&after=${encodeURIComponent(after)}`,
  );
export const readLineagePage = (link: ReadLink, lineageId: string, after: string | null) =>
  read(
    link,
    `/api/lineages/${encodeURIComponent(lineageId)}`,
    lineagePageSchema,
    `&limit=50${after === null ? '' : `&after=${encodeURIComponent(after)}`}`,
  );
export const readPassport = (link: ReadLink, organismId: string, before: string | null) =>
  read(
    link,
    `/api/organisms/${encodeURIComponent(organismId)}/passport`,
    passportSchema,
    before === null ? '' : `&before=${encodeURIComponent(before)}`,
  );
