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

import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import type { PlatformDB } from '../../../storages/interfaces/platformStorage/PlatformDB.ts';
import { verifyClientAssertion, ClientAssertionError, CLIENT_ASSERTION_TYPE } from './clientAssertion.ts';
import { markClientAssertionJtiUsed } from './storage.ts';
import { hasKeySet } from './clientAuth.ts';
import { getClientJwks, JwksFetchError } from './jwksUri.ts';
import { logServerWarning } from './serverLog.ts';
// bcrypt ships no type declarations — keep it on the require shim so the
// import does not trip noImplicitAny (real ESM import needs @types/bcrypt).
const require = createRequire(import.meta.url);
const bcrypt = require('bcrypt');

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
 * A single uniform failure for the `private_key_jwt` (assertion) path:
 * bad signature, bad claims, replayed jti, wrong assertion type, or no
 * JWKS on file — all return the SAME `invalid_client` with no
 * distinguishing description, so the response is not an oracle.
 */
const ASSERTION_FAIL: ClientAuthResult = {
  ok: false, status: 401, error: 'invalid_client', description: 'client authentication failed',
};

/** The client view authenticateClient needs: credentials on file (public keys / secret hashes). */
type ClientAuthView = {
  clientSecretHash?: unknown;
  /** The secret replaced by the last rotation, accepted until `previousSecretExpiresAt` (ms). */
  previousSecretHash?: unknown;
  previousSecretExpiresAt?: unknown;
  jwks?: { keys: unknown[] };
  jwksUri?: unknown;
  tokenEndpointAuthSigningAlgs?: unknown;
} | null | undefined;

/**
 * Whether the secret replaced by the last rotation is still accepted: a hash
 * and an expiry on file, the expiry not reached.
 */
export function previousSecretValid (client: ClientAuthView, now: number = Date.now()): boolean {
  return typeof client?.previousSecretHash === 'string' && client.previousSecretHash.length > 0 &&
    typeof client.previousSecretExpiresAt === 'number' && now < client.previousSecretExpiresAt;
}

/** The longest window a rotated secret may stay valid (30 days, ms). */
export const MAX_PREVIOUS_SECRET_WINDOW_MS = 30 * 24 * 3600 * 1000;

/**
 * Authenticate a client at the token endpoint per its confidentiality.
 *
 * A client is CONFIDENTIAL when it has a `clientSecretHash`
 * (`client_secret_basic` / `client_secret_post`) OR a key set (inline `jwks` or `jwks_uri`)
 * (`private_key_jwt`) on file. A confidential client MUST authenticate
 * via one of its registered mechanisms. A client with neither is PUBLIC:
 * PKCE is its sole protection and no client authentication is required
 * (advertised as `none`). This makes every grant's behaviour match the
 * discovery document's `token_endpoint_auth_methods_supported`.
 *
 * Precedence: when a `client_assertion` is presented it takes precedence
 * and is fully verified — a bad assertion fails even if a valid secret is
 * also presented. Every assertion-path failure is uniform `invalid_client`.
 *
 * `client` may be null (no cached registration) — treated as public, so
 * callers that don't (yet) have a registration on the exchange path keep
 * working while confidential clients are still verified once registered.
 */
export async function authenticateClient (params: {
  client: ClientAuthView;
  /** The request's authenticated client_id — needed for the assertion iss/sub check + jti burn. */
  clientId?: string | undefined;
  presentedSecret?: string | undefined;
  /** `client_assertion` form value (private_key_jwt), when present. */
  assertion?: string | undefined;
  /** `client_assertion_type` form value — must be the jwt-bearer URN. */
  assertionType?: string | undefined;
  /** Required to burn the assertion jti (single-use); absent → assertion path fails uniformly. */
  platform?: PlatformDB | undefined;
  /** Server-derived acceptable `aud` values (token-endpoint + issuer URLs). */
  expectedAudiences?: string[] | undefined;
  /** Injectable clock for tests (ms since epoch). */
  now?: number | undefined;
}): Promise<ClientAuthResult> {
  const hash = params.client?.clientSecretHash;
  const hasHash = typeof hash === 'string' && hash.length > 0;
  const jwks = params.client?.jwks;
  const hasJwks = hasKeySet(params.client);

  // --- private_key_jwt (RFC 7521/7523) — takes precedence when presented. --- //
  if (typeof params.assertion === 'string' && params.assertion.length > 0) {
    if (params.assertionType !== CLIENT_ASSERTION_TYPE) return ASSERTION_FAIL;
    if (!hasJwks) return ASSERTION_FAIL; // no keys on file — uniform, no oracle
    if (params.platform == null || typeof params.clientId !== 'string' || params.clientId.length === 0) {
      return ASSERTION_FAIL;
    }
    const algs = params.client?.tokenEndpointAuthSigningAlgs;
    const jwksUri = jwks != null && Array.isArray(jwks.keys) && jwks.keys.length > 0
      ? null
      : params.client?.jwksUri as string;
    try {
      const verifyWith = async (keys: { keys: unknown[] }) => await verifyClientAssertion(params.assertion, {
        clientId: params.clientId as string,
        jwks: keys,
        allowedAlgs: Array.isArray(algs) ? algs.filter((a): a is string => typeof a === 'string') : undefined,
        expectedAudiences: params.expectedAudiences ?? [],
        now: params.now,
      });
      let verified;
      if (jwksUri == null) {
        verified = await verifyWith(jwks as { keys: unknown[] });
      } else {
        try {
          verified = await verifyWith(await getClientJwks(jwksUri));
        } catch (err: unknown) {
          // A key the cached set does not hold: the client may have rotated it in.
          if (!(err instanceof ClientAssertionError && err.unknownKid)) throw err;
          verified = await verifyWith(await getClientJwks(jwksUri, { unknownKid: true }));
        }
      }
      // Burn the jti for its remaining lifetime — a replay within the window fails.
      const fresh = await markClientAssertionJtiUsed(
        params.platform, params.clientId, verified.jti, verified.exp * 1000
      );
      if (!fresh) return ASSERTION_FAIL; // replayed
    } catch (err: unknown) {
      // An unusable key set URL is the operator's to know (rate-bounded by the cache).
      if (err instanceof JwksFetchError) logServerWarning('client ' + params.clientId + ': jwks_uri unusable: ' + err.reason);
      return ASSERTION_FAIL; // bad signature / claims — uniform
    }
    return { ok: true };
  }

  // --- No assertion presented: secret or public. --- //
  if (hasHash) {
    if (typeof params.presentedSecret !== 'string' || params.presentedSecret.length === 0) {
      return { ok: false, status: 401, error: 'invalid_client', description: 'client authentication required' };
    }
    // The secret on file, or the one the last rotation replaced while its window lasts.
    const good = await verifySecret(params.presentedSecret, hash as string) ||
      (previousSecretValid(params.client, params.now ?? Date.now()) &&
        await verifySecret(params.presentedSecret, params.client!.previousSecretHash as string));
    if (!good) {
      return { ok: false, status: 401, error: 'invalid_client', description: 'client authentication failed' };
    }
    return { ok: true };
  }
  if (hasJwks) {
    // Confidential via private_key_jwt, but no assertion was presented.
    return { ok: false, status: 401, error: 'invalid_client', description: 'client authentication required' };
  }
  return { ok: true }; // public client — PKCE only
}

function base64url (buf: Buffer): string {
  return buf.toString('base64')
    .replace(/=+$/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
}
