/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * One-time codes and bearer tokens of the administration features.
 *
 * - A **code** (setup code, administrator claim code) is typed by a person:
 *   130 random bits as 26 characters of Crockford's base32 (no I, L, O, U),
 *   shown in groups (`XXXXX-XXXXX-XXXXX-XXXXX-XXXXXX`). Input is read
 *   leniently: case, dashes and spaces are ignored, `O` reads as `0`, `I` and
 *   `L` as `1`.
 * - A **token** (setup session, admin session) is handled by software: 256
 *   random bits, base64url (43 characters).
 *
 * Neither is ever stored: only its SHA-256 (hex) is, as the key of the row
 * that holds its state. The values carry enough entropy that a plain hash is
 * the right tool (a slow hash protects guessable secrets, not these).
 */

export const CODE_BITS = 130;
export const TOKEN_BITS = 256;

const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const CODE_LENGTH = CODE_BITS / 5; // 26
const CANONICAL_CODE_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/;
const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;
const SHA256_HEX_RE = /^[0-9a-f]{64}$/;
/** Longest input accepted before normalization (a code with generous separators). */
const MAX_CODE_INPUT = 64;

/** A new code, in canonical form (26 characters, no separator). */
export function generateCode (): string {
  const bytes = randomBytes(Math.ceil(CODE_BITS / 8)); // 17 bytes, 136 bits
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5 && out.length < CODE_LENGTH) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
    value &= (1 << bits) - 1;
  }
  return out;
}

/** The display form of a canonical code: groups of five, the last one six. */
export function formatCode (canonical: string): string {
  return [0, 5, 10, 15].map((i) => canonical.slice(i, i + 5)).join('-') + '-' + canonical.slice(20);
}

/** The canonical form of a typed code, or null when it cannot be one. */
export function normalizeCode (input: unknown): string | null {
  if (typeof input !== 'string' || input.length > MAX_CODE_INPUT) return null;
  const canonical = input.toUpperCase()
    .replace(/[\s-]/g, '')
    .replace(/O/g, '0')
    .replace(/[IL]/g, '1');
  return CANONICAL_CODE_RE.test(canonical) ? canonical : null;
}

/** SHA-256 (hex) of a code in canonical form. */
export function hashCode (canonical: string): string {
  if (!CANONICAL_CODE_RE.test(canonical)) throw new Error('hashCode: not a canonical code');
  return sha256Hex(canonical);
}

/** A new bearer token. */
export function generateToken (): string {
  return randomBytes(TOKEN_BITS / 8).toString('base64url');
}

export function isTokenShape (token: unknown): token is string {
  return typeof token === 'string' && TOKEN_RE.test(token);
}

/** SHA-256 (hex) of a token. */
export function hashToken (token: string): string {
  if (!isTokenShape(token)) throw new Error('hashToken: not a token');
  return sha256Hex(token);
}

export function isSha256Hex (value: unknown): value is string {
  return typeof value === 'string' && SHA256_HEX_RE.test(value);
}

/** Constant-time comparison of two SHA-256 hex digests (false when either is not one). */
export function hashesEqual (a: unknown, b: unknown): boolean {
  if (!isSha256Hex(a) || !isSha256Hex(b)) return false;
  return timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));
}

function sha256Hex (value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}
