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

// The loopback hosts on which a plain-http resource is accepted (local
// development): the same list as for plain-http redirect URIs.
import { LOOPBACK_HOSTS } from './clientRegistry.ts';

/**
 * Upper bound on a resource indicator a client names without a registered
 * list, in bytes (it rides in the signed state and the consent redirect).
 */
export const MAX_RESOURCE_BYTES = 512;

/**
 * Whether a presented value is short enough to be compared at all: at most
 * `MAX_RESOURCE_BYTES`, or the longest of the values it may match (a
 * registered audience, a stored one). Checked before any comparison, so the
 * work spent on a client-chosen value stays bounded.
 */
export function withinResourceCap (value: string, known: readonly string[] = []): boolean {
  let cap = MAX_RESOURCE_BYTES;
  for (const k of known) if (typeof k === 'string' && k.length > cap) cap = k.length;
  // UTF-16 length never exceeds the UTF-8 byte length.
  return value.length <= cap && Buffer.byteLength(value, 'utf8') <= cap;
}

/**
 * Two resource indicators name the same resource: a trailing slash and the
 * case of the scheme and host (RFC 3986 § 6.2.2.1) are ignored; the path and
 * query compare as written.
 */
export function sameResource (a: string, b: string): boolean {
  return comparable(a) === comparable(b);
}

/** Without its trailing slashes (a linear scan: the value is client input). */
export function trimSlash (s: string): string {
  let end = s.length;
  while (end > 0 && s.charCodeAt(end - 1) === 0x2f) end--;
  return end === s.length ? s : s.slice(0, end);
}

// `scheme://authority`, as written (anchored, so matched in linear time).
const SCHEME_AUTHORITY_RE = /^[a-z][a-z0-9+.-]*:\/\/[^/?#]*/i;

function comparable (s: string): string {
  const t = trimSlash(s);
  const m = SCHEME_AUTHORITY_RE.exec(t);
  return m == null ? t : m[0].toLowerCase() + t.slice(m[0].length);
}

/**
 * A resource indicator no registered list vouches for (RFC 8707 § 2): an
 * absolute URL of visible ASCII characters, `https` (or `http` on a loopback
 * host), without fragment, user information or backslash, at most
 * `MAX_RESOURCE_BYTES` bytes.
 */
export function isValidResource (value: string): boolean {
  if (!withinResourceCap(value)) return false;
  if (!/^[\x21-\x7e]+$/.test(value) || value.includes('#') || value.includes('\\')) return false;
  const authority = SCHEME_AUTHORITY_RE.exec(value)?.[0];
  if (authority == null || !/^https?:\/\/[^/]/i.test(authority) || authority.includes('@')) return false;
  let u: URL;
  try { u = new URL(value); } catch { return false; }
  if (u.username !== '' || u.password !== '') return false;
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
  if (audience == null || !withinResourceCap(resource, [audience]) || !sameResource(resource, audience)) {
    return { ok: false, status: 400, error: 'invalid_target', description: 'resource is not the resource this authorization was granted for' };
  }
  return null;
}
