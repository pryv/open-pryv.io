/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/**
 * OAuth2 — bearer-credential generator.
 *
 * Authorization codes and refresh tokens are bearer credentials: possession
 * alone grants access, so they must be unguessable. RFC 6749 §10.10 requires
 * ≥128 bits of CSPRNG entropy for such secrets. `crypto.randomBytes(32)` gives
 * 256 bits, base64url-encoded to a URL-safe opaque string.
 *
 * (A generic collision-resistant id such as cuid embeds a guessable
 * timestamp + counter and exposes only a few dozen bits of randomness — well
 * below the bar for a bearer credential, especially a long-lived refresh
 * token — so it must not be used for these.)
 */

import { randomBytes } from 'node:crypto';

/** Entropy per token in bytes (256 bits). */
const TOKEN_BYTES = 32;

/** Mint a fresh opaque bearer token (base64url, 256 bits of CSPRNG entropy). */
export function generateToken (): string {
  return base64url(randomBytes(TOKEN_BYTES));
}

function base64url (buf: Buffer): string {
  return buf.toString('base64')
    .replace(/=+$/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
}
