import { canonicalJson, sha256Hex } from '@ripple/engine';
/** RFC 9562 custom UUIDv8, derived from accepted command identity, independent of replay world. */
export function operationId(channelId: string, sequence: number, purpose: string): string {
  const hash = sha256Hex(canonicalJson([channelId, sequence, purpose]));
  const variant = ((Number.parseInt(hash.slice(16, 17), 16) & 3) | 8).toString(16);
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-8${hash.slice(13, 16)}-${variant}${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
}
