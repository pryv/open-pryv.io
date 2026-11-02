/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/**
 * OAuth2: resource indicators (RFC 8707).
 *
 * `/oauth2/authorize` takes the resource server a session is for as `aud` or
 * as its RFC 8707 spelling `resource`; one value per authorization, stored on
 * the code, refresh and session rows as `audience` and answered as `aud` by
 * introspection. `/oauth2/token` may repeat it on the authorization-code and
 * refresh-token grants; any other value is refused with `invalid_target`.
 */

/**
 * Upper bound on a resource indicator a client names without a registered
 * list, in bytes (it rides in the signed state and the consent redirect).
 */
export const MAX_RESOURCE_BYTES = 512;

// The loopback hosts on which a plain-http resource is accepted (local
// development): the same list as for plain-http redirect URIs.
const LOOPBACK_HOSTS = ['127.0.0.1', '[::1]', 'localhost'];

/** Two resource indicators name the same resource (a trailing slash is ignored). */
export function sameResource (a: string, b: string): boolean {
  return trimSlash(a) === trimSlash(b);
}

export function trimSlash (s: string): string {
  return s.replace(/\/+$/, '');
}

/**
 * A resource indicator no registered list vouches for (RFC 8707 § 2): an
 * absolute URL of visible ASCII characters, `https` (or `http` on a loopback
 * host), without fragment, at most `MAX_RESOURCE_BYTES` bytes.
 */
export function isValidResource (value: string): boolean {
  if (Buffer.byteLength(value, 'utf8') > MAX_RESOURCE_BYTES) return false;
  if (!/^[\x21-\x7e]+$/.test(value) || value.includes('#')) return false;
  if (!/^https?:\/\/[^/]/i.test(value)) return false;
  let u: URL;
  try { u = new URL(value); } catch { return false; }
  if (u.protocol === 'https:') return u.hostname !== '';
  return u.protocol === 'http:' && LOOPBACK_HOSTS.includes(u.hostname);
}

/**
 * The `resource` parameter of a token request (RFC 8707 § 2.2) against the
 * audience the authorization named: absent (or empty) is fine, otherwise it
 * must be that audience. A session holds one audience, so equality is the
 * subset test. Null when accepted, else the `invalid_target` refusal.
 */
export function checkTokenResource (resource: unknown, audience: string | undefined):
  null | { ok: false; status: 400; error: 'invalid_target'; description: string } {
  if (resource == null || resource === '') return null;
  if (typeof resource !== 'string') {
    return { ok: false, status: 400, error: 'invalid_target', description: 'one resource per request' };
  }
  if (audience == null || !sameResource(resource, audience)) {
    return { ok: false, status: 400, error: 'invalid_target', description: 'resource is not the resource this authorization was granted for' };
  }
  return null;
}
