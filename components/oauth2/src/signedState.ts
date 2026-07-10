/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/**
 * OAuth2 — signed URL-parameter state.
 *
 * The `/oauth2/authorize` handler validates the client's parameters and
 * then redirects the user-agent to the consent UI (typically served
 * from a different (sub)domain by app-web-auth3). Cross-domain handoff
 * via a cookie has too many gotchas, so the handoff goes over a signed
 * URL parameter instead.
 *
 * Payload shape (JSON before base64url):
 *   { clientId, redirectUri, state, codeChallenge, codeChallengeMethod,
 *     scope: string[], userIdHint?: string, iat, exp }
 *
 * Wire format:  `<base64url(JSON)>.<base64url(HMAC-SHA256)>`
 *
 * Lifetime is short (default 5 minutes — enough for the user to be
 * routed through the consent UI, not so long that a leaked state is
 * dangerous). A stolen state is useless without the matching PKCE
 * `code_verifier` (which never leaves the client).
 *
 * The signing key is derived from `auth.adminAccessKey` via
 * HMAC-SHA256 with a fixed label, so it rotates whenever the operator
 * rotates the admin key. No additional config key needed.
 */

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

const crypto = require('node:crypto');

/** Maximum lifetime of a signed state, in seconds. */
export const SIGNED_STATE_TTL_SECONDS = 300;

/** Payload carried between /oauth2/authorize and /oauth2/authorize/accept. */
export type SignedStatePayload = {
  clientId: string;
  redirectUri: string;
  state: string;
  codeChallenge: string;
  codeChallengeMethod: 'S256';
  scope: string[];
  userIdHint?: string;
  /**
   * Present when scope is a `cmc:<offer-name>` reference: the offer
   * material resolved server-side at authorize time (granular
   * permissions + consent texts + capability handle). The accept path
   * mints ONLY from this signed copy — the consent UI displays it and
   * returns a subset, never a source of truth of its own.
   */
  offer?: {
    offerName: string;
    capabilityUrl: string;
    capabilityId: string | null;
    offerEventId: string | null;
    /** Consent form — per-entry `mandatory` annotation preserved. */
    permissions: Array<Record<string, unknown>>;
    /** Default FALSE: ALL OR NOTHING; true enables cherry-picking
     * (mandatory entries stay locked). */
    allowUserChoice: boolean;
    title?: Record<string, string>;
    description?: Record<string, string>;
    consent?: Record<string, string>;
    requesterMeta?: Record<string, unknown>;
  };
  iat: number;
  exp: number;
};

const SIGNING_LABEL = Buffer.from('pryv-oauth2-signed-state-v1');

/**
 * Derive the HMAC signing key from the operator's admin key. Same
 * input → same key (deterministic), so signed states issued by one
 * core verify on any other core in the cluster (admin key is operator-
 * sync). Re-derivation is cheap; not memoised.
 */
function deriveKey (adminKey: string): Buffer {
  if (typeof adminKey !== 'string' || adminKey.length === 0) {
    throw new Error('signedState: adminKey must be a non-empty string');
  }
  return crypto.createHmac('sha256', adminKey).update(SIGNING_LABEL).digest();
}

function base64urlEncode (buf: Buffer): string {
  return buf.toString('base64').replace(/=+$/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

function base64urlDecode (s: string): Buffer {
  const padded = s.replace(/-/g, '+').replace(/_/g, '/') + '=='.slice(0, (4 - s.length % 4) % 4);
  return Buffer.from(padded, 'base64');
}

/**
 * Sign a payload. `iat` + `exp` are stamped by this function — callers
 * pass only the request-derived fields.
 */
export function signState (
  adminKey: string,
  payload: Omit<SignedStatePayload, 'iat' | 'exp'>,
  nowSeconds: number = Math.floor(Date.now() / 1000),
  ttlSeconds: number = SIGNED_STATE_TTL_SECONDS,
): string {
  const full: SignedStatePayload = { ...payload, iat: nowSeconds, exp: nowSeconds + ttlSeconds };
  const json = Buffer.from(JSON.stringify(full));
  const body = base64urlEncode(json);
  const key = deriveKey(adminKey);
  const mac = base64urlEncode(crypto.createHmac('sha256', key).update(body).digest());
  return body + '.' + mac;
}

/** Outcome of a verify call — typed result rather than throw, since callers branch. */
export type VerifyResult =
  | { ok: true; payload: SignedStatePayload }
  | { ok: false; reason: 'malformed' | 'bad_signature' | 'expired' | 'not_yet_valid' };

/**
 * Verify a signed state string. Constant-time signature comparison.
 * Returns a tagged result; callers map to RFC 6749 error enums.
 */
export function verifyState (
  adminKey: string,
  token: string,
  nowSeconds: number = Math.floor(Date.now() / 1000),
): VerifyResult {
  if (typeof token !== 'string') return { ok: false, reason: 'malformed' };
  const dot = token.indexOf('.');
  if (dot <= 0 || dot === token.length - 1) return { ok: false, reason: 'malformed' };
  const body = token.slice(0, dot);
  const macPresented = token.slice(dot + 1);
  let macExpected: string;
  try {
    const key = deriveKey(adminKey);
    macExpected = base64urlEncode(crypto.createHmac('sha256', key).update(body).digest());
  } catch {
    return { ok: false, reason: 'malformed' };
  }
  if (macPresented.length !== macExpected.length) return { ok: false, reason: 'bad_signature' };
  if (!crypto.timingSafeEqual(Buffer.from(macPresented), Buffer.from(macExpected))) {
    return { ok: false, reason: 'bad_signature' };
  }
  let payload: SignedStatePayload;
  try {
    payload = JSON.parse(base64urlDecode(body).toString('utf8'));
  } catch {
    return { ok: false, reason: 'malformed' };
  }
  if (typeof payload.iat !== 'number' || typeof payload.exp !== 'number') {
    return { ok: false, reason: 'malformed' };
  }
  if (nowSeconds < payload.iat) return { ok: false, reason: 'not_yet_valid' };
  if (nowSeconds >= payload.exp) return { ok: false, reason: 'expired' };
  return { ok: true, payload };
}
