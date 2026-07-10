/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/**
 * OAuth2 — client_secret hashing helpers.
 *
 * bcrypt is the operator-vetted choice (already in deps). Functionally
 * equivalent to Argon2id for OAuth's needs: one-way, salted, slow
 * enough that an offline crack costs more than legitimate use. Cost
 * factor 10 (the bcrypt default) → ~100ms/verify on commodity hardware
 * — fine for a token-endpoint call rate; impossibly slow for a brute
 * force.
 *
 * The hash is safe to replicate cluster-wide (PlatformDB
 * `oauth-client/<id>.clientSecretHash`). The plaintext is shown to the
 * operator exactly ONCE at mint time (CLI prints to stdout) and never
 * stored.
 */

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

const bcrypt = require('bcrypt');
const crypto = require('node:crypto');

/** Cost factor — 10 ≈ 100ms/verify on commodity hardware. */
const BCRYPT_COST = 10;

/** Plaintext secret length in bytes (256 bits of entropy after base64url). */
const SECRET_BYTES = 32;

/**
 * Mint a fresh client_secret. Returns BOTH the plaintext (show to the
 * operator once) AND the bcrypt hash (persist in PlatformDB).
 */
export async function mintSecret (): Promise<{ plaintext: string; hash: string }> {
  const plaintext = base64url(crypto.randomBytes(SECRET_BYTES));
  const hash = await bcrypt.hash(plaintext, BCRYPT_COST);
  return { plaintext, hash };
}

/**
 * Constant-time verify a presented secret against a stored hash.
 * Returns false on any error (missing hash, malformed presentation,
 * bcrypt failure) — never throws to the caller.
 */
export async function verifySecret (presented: string, hash: string): Promise<boolean> {
  if (typeof presented !== 'string' || presented.length === 0) return false;
  if (typeof hash !== 'string' || hash.length === 0) return false;
  try {
    return await bcrypt.compare(presented, hash);
  } catch {
    return false;
  }
}

/**
 * Outcome of a client-authentication check at the token endpoint.
 * `ok: false` carries the RFC 6749 fields the grant returns verbatim.
 */
export type ClientAuthResult =
  | { ok: true }
  | { ok: false; status: number; error: string; description: string };

/**
 * Authenticate a client at the token endpoint per its confidentiality.
 *
 * A client that has a `clientSecretHash` on file is CONFIDENTIAL: it
 * must present a matching `client_secret` (advertised as
 * `client_secret_basic`). A client with no secret on file is PUBLIC:
 * PKCE is its sole protection and no secret is required (advertised as
 * `none`). This makes every grant's behaviour match the discovery
 * document's `token_endpoint_auth_methods_supported`.
 *
 * `client` may be null (no cached registration) — treated as public, so
 * callers that don't (yet) have a registration on the exchange path keep
 * working while confidential clients are still verified once registered.
 */
export async function authenticateClient (params: {
  client: { clientSecretHash?: unknown } | null | undefined;
  presentedSecret: string | undefined;
}): Promise<ClientAuthResult> {
  const hash = params.client?.clientSecretHash;
  if (typeof hash !== 'string' || hash.length === 0) {
    return { ok: true }; // public client — PKCE only
  }
  if (typeof params.presentedSecret !== 'string' || params.presentedSecret.length === 0) {
    return { ok: false, status: 401, error: 'invalid_client', description: 'client authentication required' };
  }
  const good = await verifySecret(params.presentedSecret, hash);
  if (!good) {
    return { ok: false, status: 401, error: 'invalid_client', description: 'client authentication failed' };
  }
  return { ok: true };
}

function base64url (buf: Buffer): string {
  return buf.toString('base64')
    .replace(/=+$/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
}
