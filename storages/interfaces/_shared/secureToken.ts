/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/**
 * Bearer secrets minted by the server (access tokens, session ids, password
 * reset tokens): drawn from `node:crypto` directly, so their strength never
 * depends on what an id library falls back to. Same shape as the ids clients
 * already see: a lowercase letter, then 24 lowercase letters or digits
 * (25 characters, about 124 bits). Ids that are not secrets keep cuid2.
 */

import { randomBytes } from 'node:crypto';

const LETTERS = 'abcdefghijklmnopqrstuvwxyz';
const ALPHANUMS = 'abcdefghijklmnopqrstuvwxyz0123456789';
const BODY_LENGTH = 24;

/** Uniform draw from `alphabet`: bytes at or above the largest multiple of its length are dropped (no modulo bias). */
function draw (alphabet: string, count: number): string {
  const limit = 256 - (256 % alphabet.length);
  let out = '';
  while (out.length < count) {
    for (const byte of randomBytes(count * 2)) {
      if (byte >= limit) continue;
      out += alphabet[byte % alphabet.length];
      if (out.length === count) break;
    }
  }
  return out;
}

/** A new bearer secret: 25 characters, `[a-z][a-z0-9]{24}`. */
export function secureToken (): string {
  return draw(LETTERS, 1) + draw(ALPHANUMS, BODY_LENGTH);
}

export const SECURE_TOKEN_PATTERN = /^[a-z][a-z0-9]{24}$/;
