/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/**
 * Shared secrets — key material and signature verification.
 *
 * A key is composite: `<eventId>.<randomPart>`. The event id makes retrieval an
 * O(1) lookup; the random part is the actual credential. Only SHA-256 of the
 * random part is ever stored, so a database dump cannot reconstruct a live key.
 *
 * The random part may be minted here (`mint`) or supplied by the caller as a
 * hash (`isStorableHash`). The latter exists because an `hmac-sha256` signature
 * has to be bound to the key material *before* the item is created, and a
 * server-minted key is only known afterwards — so a caller that wants to sign
 * generates the random part itself and sends nothing but its hash.
 */

import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';

/** Entropy of the random half, in bytes (192 bits → 32 base64url chars). */
const RANDOM_BYTES = 24;
/** Shortest random half we accept, in characters (192 bits base64url-encoded). */
const RANDOM_MIN_CHARS = 32;
const RANDOM_MAX_CHARS = 128;
const EVENT_ID_MAX_CHARS = 64;

/** base64url alphabet only — the charset `mint` produces. */
const RANDOM_RE = new RegExp('^[A-Za-z0-9_-]{' + RANDOM_MIN_CHARS + ',' + RANDOM_MAX_CHARS + '}$');
/** Event ids are cuid-shaped; anything with a dot, slash or quote is not one. */
const EVENT_ID_RE = new RegExp('^[A-Za-z0-9_-]{1,' + EVENT_ID_MAX_CHARS + '}$');
/** Hex SHA-256. */
const HASH_RE = /^[0-9a-f]{64}$/;

export type ParsedKey = { eventId: string; randomPart: string };
export type MintedKey = { key: string; keyHash: string };
// `value` is absent once the item is scrubbed at transition; a value-less
// configured signature can never be satisfied, which is the safe outcome.
export type Signature = { type: string; value?: string } | null | undefined;
export type GivenSignature = { type?: string; payload?: unknown } | null | undefined;

/** The signature methods a caller may ask for. */
export const SIGNATURE_TYPES = Object.freeze(['secret', 'hmac-sha256']);

/** SHA-256 of a random half, hex — the only form ever persisted. */
export function hashRandomPart (randomPart: string): string {
  return createHash('sha256').update(randomPart, 'utf8').digest('hex');
}

/** Mint a fresh key for `eventId`, returning it alongside its storable hash. */
export function mint (eventId: string): MintedKey {
  const randomPart = base64url(randomBytes(RANDOM_BYTES));
  return { key: eventId + '.' + randomPart, keyHash: hashRandomPart(randomPart) };
}

/** True when a caller-supplied `keyHash` is a full-strength SHA-256 hex digest. */
export function isStorableHash (value: unknown): boolean {
  return typeof value === 'string' && HASH_RE.test(value);
}

/**
 * Split a key into its parts, or null if it is not a key at all.
 *
 * Returns null rather than throwing: this runs on unauthenticated input, so
 * every malformed shape has to land on the same quiet path as a wrong guess.
 */
export function parse (key: unknown): ParsedKey | null {
  if (typeof key !== 'string') return null;
  if (key.length > EVENT_ID_MAX_CHARS + RANDOM_MAX_CHARS + 1) return null;
  const parts = key.split('.');
  if (parts.length !== 2) return null;
  const [eventId, randomPart] = parts;
  if (!EVENT_ID_RE.test(eventId)) return null;
  if (!RANDOM_RE.test(randomPart)) return null;
  return { eventId, randomPart };
}

/**
 * Expiry is exactly `now > time + duration` — the item's own event fields, no
 * separate expiry column. A missing, null or non-positive duration means the
 * item is treated as expired: an unbounded shared secret must not exist, so an
 * absent TTL fails closed rather than living forever.
 */
export function isExpired (item: { time: number; duration?: number | null }, now: number): boolean {
  const duration = item?.duration;
  if (typeof duration !== 'number' || !(duration > 0)) return true;
  return now > item.time + duration;
}

/**
 * Verify a retrieval's signature payload against the one configured at creation.
 *
 * Both supported types reduce to a constant-time comparison of two strings: for
 * `secret` the payload IS the expected value; for `hmac-sha256` the payload is
 * HMAC(verifierSecret, randomPart) computed by the caller, so the verifier
 * secret itself never reaches this process.
 */
export function verifySignature (
  configured: Signature,
  given: GivenSignature,
  _key?: string
): boolean {
  if (configured == null) return true; // nothing to prove
  // A scrubbed (value-less) signature can never be satisfied — but it only ever
  // sits on a terminal item, which is refused before this runs.
  if (typeof configured.value !== 'string') return false;
  if (given == null || typeof given !== 'object') return false;
  if (given.type !== configured.type) return false;
  if (typeof given.payload !== 'string') return false;
  return constantTimeEquals(given.payload, configured.value);
}

/**
 * Constant-time string comparison that tolerates a length mismatch.
 *
 * `timingSafeEqual` throws when the two buffers differ in length, which on a
 * public endpoint would turn "wrong length" into a distinguishable outcome —
 * so length is checked first and reported as a plain mismatch.
 */
export function constantTimeEquals (a: string, b: string): boolean {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

function base64url (buf: Buffer): string {
  return buf.toString('base64')
    .replace(/=+$/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
}
