/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/**
 * Third-party sign-in — signed state cookie.
 *
 * The relying-party state (which provider, and the `state` / `nonce` / PKCE
 * `code_verifier` that bind the IdP round-trip) must survive the redirect to
 * the IdP and back with NO server-side store. It rides a signed, HttpOnly,
 * Secure, `SameSite=Lax`, path-scoped (`/auth/sso/`) cookie:
 *
 *   wire format:  `<base64url(JSON payload)>.<base64url(HMAC-SHA256)>`
 *
 * `SameSite=Lax` is REQUIRED: the IdP callback is a top-level cross-site GET
 * navigation, which `Strict` would strip the cookie from. The signing key is
 * derived from `auth.adminAccessKey` (a DISTINCT label from the oauth2 signed
 * state), so it rotates with the admin key and needs no new config, and a
 * value minted on one core verifies on any other (admin key is operator-sync).
 *
 * The cookie carries the PKCE `code_verifier`: signing gives integrity, and
 * confidentiality rests on HttpOnly + Secure (TLS) + the short TTL. The
 * callback consumes it ONE-SHOT (clear before use), so a replayed callback URL
 * finds no cookie and fails closed.
 *
 * The cookie may also carry `returnState`, an opaque string the auth app handed
 * to `/start` (`ssoReturn` query) and gets back on the landing fragment once
 * this cookie verifies. Shape-checked only (length + alphabet), never
 * interpreted.
 */

import crypto from 'node:crypto';

/** Cookie name + path. Path-scoping keeps it off every other request. */
export const STATE_COOKIE_NAME = 'pryv_sso_state';
export const STATE_COOKIE_PATH = '/auth/sso/';

/** Maximum lifetime of a state cookie, in seconds (10 minutes). */
export const STATE_COOKIE_TTL_SECONDS = 600;

const SIGNING_LABEL = Buffer.from('pryv-sso-state-v1');

/**
 * Bounds on the opaque return state. The alphabet is exactly what
 * `URLSearchParams` serialization emits, so anything else (space, `#`, `;`,
 * quotes, control characters) is refused at `/start`: it keeps the value
 * trivially safe in a URL fragment and the request log line clean.
 *
 * 2048 characters is the budget that keeps the signed cookie inside the 4096
 * byte per-cookie limit alongside the round-trip fields.
 */
export const RETURN_STATE_MAX_CHARS = 2048;
export const RETURN_STATE_RE = /^[A-Za-z0-9*._%+=&-]*$/;

/** Shape guard for the opaque return state — length + alphabet, no parsing. */
export function isValidReturnState (value: unknown): value is string {
  return typeof value === 'string' &&
    value.length <= RETURN_STATE_MAX_CHARS &&
    RETURN_STATE_RE.test(value);
}

/** What the cookie carries across the IdP round-trip. */
export type StateCookiePayload = {
  provider: string;
  state: string;
  nonce: string;
  pkceVerifier: string;
  /** Opaque, app-chosen return context. Never read by the core. */
  returnState?: string;
  iat: number;
  exp: number;
};

/**
 * Derive the HMAC signing key from the operator admin key. Deterministic
 * (same key on every core); distinct label from oauth2's signed state so the
 * two signing domains never overlap.
 */
function deriveKey (adminKey: string): Buffer {
  if (typeof adminKey !== 'string' || adminKey.length === 0) {
    throw new Error('sso stateCookie: adminKey must be a non-empty string');
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
 * Sign a state payload into the cookie value. `iat` / `exp` are stamped here;
 * callers pass only the round-trip fields.
 */
export function signStateCookie (
  adminKey: string,
  payload: Omit<StateCookiePayload, 'iat' | 'exp'>,
  nowSeconds: number = Math.floor(Date.now() / 1000),
  ttlSeconds: number = STATE_COOKIE_TTL_SECONDS
): string {
  const full: StateCookiePayload = { ...payload, iat: nowSeconds, exp: nowSeconds + ttlSeconds };
  const body = base64urlEncode(Buffer.from(JSON.stringify(full)));
  const key = deriveKey(adminKey);
  const mac = base64urlEncode(crypto.createHmac('sha256', key).update(body).digest());
  return body + '.' + mac;
}

/** Tagged verify result — callers branch on the reason rather than catch. */
export type VerifyCookieResult =
  | { ok: true; payload: StateCookiePayload }
  | { ok: false; reason: 'malformed' | 'bad_signature' | 'expired' | 'not_yet_valid' };

/**
 * Verify + decode a cookie value. Constant-time signature comparison; every
 * failure mode is a distinct tag but the caller maps them all to ONE uniform
 * user-facing error (no oracle).
 */
export function verifyStateCookie (
  adminKey: string,
  value: string,
  nowSeconds: number = Math.floor(Date.now() / 1000)
): VerifyCookieResult {
  if (typeof value !== 'string') return { ok: false, reason: 'malformed' };
  const dot = value.indexOf('.');
  if (dot <= 0 || dot === value.length - 1) return { ok: false, reason: 'malformed' };
  const body = value.slice(0, dot);
  const macPresented = value.slice(dot + 1);
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
  let payload: StateCookiePayload;
  try {
    payload = JSON.parse(base64urlDecode(body).toString('utf8'));
  } catch {
    return { ok: false, reason: 'malformed' };
  }
  if (typeof payload.iat !== 'number' || typeof payload.exp !== 'number' ||
      typeof payload.provider !== 'string' || typeof payload.state !== 'string' ||
      typeof payload.nonce !== 'string' || typeof payload.pkceVerifier !== 'string') {
    return { ok: false, reason: 'malformed' };
  }
  // Absent is valid (a start that carried no return context, or a cookie minted
  // before this field existed); present but out of shape fails closed.
  if (payload.returnState !== undefined && !isValidReturnState(payload.returnState)) {
    return { ok: false, reason: 'malformed' };
  }
  if (nowSeconds < payload.iat) return { ok: false, reason: 'not_yet_valid' };
  if (nowSeconds >= payload.exp) return { ok: false, reason: 'expired' };
  return { ok: true, payload };
}

/** Cookie attributes for `res.cookie(STATE_COOKIE_NAME, value, cookieOptions())`. */
export function cookieOptions (): {
  httpOnly: boolean; secure: boolean; sameSite: 'lax'; path: string; maxAge: number;
} {
  return {
    httpOnly: true,
    secure: true,
    sameSite: 'lax',
    path: STATE_COOKIE_PATH,
    maxAge: STATE_COOKIE_TTL_SECONDS * 1000
  };
}
