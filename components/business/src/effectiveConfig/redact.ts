/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/**
 * Value-level redaction for the effective configuration document: the scan
 * every shown string goes through, the redacted-entry builder, the keyed
 * fingerprint of secrets and the canonical serialisation the digests hash.
 */

import { createHmac } from 'node:crypto';
import { isPlaceholderValue, weakSecretReason } from '../secretValues.ts';

export type RedactionClass = 'secret' | 'opaque' | 'unclassified' | 'value-pattern' | 'shape-mismatch' | 'unsupported-type';
export type ValueType = 'string' | 'number' | 'boolean' | 'object' | 'array' | 'null';

export type RedactedEntry = {
  redacted: true,
  class: RedactionClass,
  set: boolean,
  type: ValueType,
  placeholder?: true,
  size?: number,
  fingerprint?: string
};

export const MAX_STRING_LENGTH = 4096;
const FINGERPRINT_LABEL = 'pryv.io effective-config fingerprint v1';
const FINGERPRINT_HEX_LENGTH = 12;
/** Live secret values shorter than this are not searched for inside shown strings. */
const MIN_NEEDLE_LENGTH = 8;

export function valueType (value: unknown): ValueType {
  if (value === null || value === undefined) return 'null';
  if (Array.isArray(value)) return 'array';
  const t = typeof value;
  if (t === 'string' || t === 'number' || t === 'boolean') return t;
  return 'object';
}

/** False for null, undefined, '', {} and []. */
export function isSet (value: unknown): boolean {
  if (value === null || value === undefined || value === '') return false;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === 'object') return Object.keys(value as object).length > 0;
  return true;
}

// Values of `auth.filesReadTokenSecret` published in this repository (development
// and test configurations): anyone can key with them, so they key nothing.
const PUBLISHED_FILES_READ_SECRETS: readonly string[] = [
  'dev-only-files-read-token-secret', 'libjs-test-files-secret', 'rt-files-secret-roundtrip', 'some_token'
];

/**
 * The fingerprint key, derived from `auth.filesReadTokenSecret` (required
 * identical on every core, never shown), or null when that secret is too weak
 * to key with (a placeholder, a published value, shorter than
 * MIN_SECRET_LENGTH): then the document carries no fingerprint at all.
 */
export function fingerprintKey (filesReadTokenSecret: unknown): Buffer | null {
  if (typeof filesReadTokenSecret !== 'string') return null;
  if (weakSecretReason(filesReadTokenSecret, { production: true }) != null) return null;
  if (PUBLISHED_FILES_READ_SECRETS.includes(filesReadTokenSecret.trim())) return null;
  return createHmac('sha256', filesReadTokenSecret).update(FINGERPRINT_LABEL).digest();
}

/** Path-bound keyed fingerprint: equal secrets at two paths do not compare equal. */
export function fingerprint (key: Buffer, path: string, value: unknown): string {
  return createHmac('sha256', key).update(path + '\n' + stableStringify(value)).digest('hex').slice(0, FINGERPRINT_HEX_LENGTH);
}

export function redactedEntry (cls: RedactionClass, value: unknown, options: { size?: boolean, fingerprint?: string | null } = {}): RedactedEntry {
  const entry: RedactedEntry = { redacted: true, class: cls, set: isSet(value), type: valueType(value) };
  if (isPlaceholderValue(value)) entry.placeholder = true;
  if (options.size === true && value != null && typeof value === 'object') {
    entry.size = Array.isArray(value) ? value.length : Object.keys(value).length;
  }
  if (options.fingerprint != null && entry.set) entry.fingerprint = options.fingerprint;
  return entry;
}

/**
 * Canonical JSON: object keys sorted (default string order), arrays in order,
 * no whitespace, `undefined` members dropped. The digests hash this form.
 */
export function stableStringify (value: unknown): string {
  if (value === undefined) return 'null';
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map((v) => v === undefined ? 'null' : stableStringify(v)).join(',') + ']';
  const obj = value as Record<string, unknown>;
  const parts: string[] = [];
  for (const k of Object.keys(obj).sort()) {
    if (obj[k] === undefined) continue;
    parts.push(JSON.stringify(k) + ':' + stableStringify(obj[k]));
  }
  return '{' + parts.join(',') + '}';
}

/**
 * The live secret strings searched for inside every shown string, with their
 * base64, base64url and URL-encoded forms.
 */
export function secretNeedles (values: unknown[]): string[] {
  const out = new Set<string>();
  const add = (v: unknown, depth: number) => {
    if (depth > 12) return;
    if (typeof v === 'string') {
      if (v.length < MIN_NEEDLE_LENGTH || isPlaceholderValue(v)) return;
      const buf = Buffer.from(v, 'utf8');
      for (const form of [v, buf.toString('base64').replace(/=+$/, ''), buf.toString('base64url'), encodeURIComponent(v)]) out.add(form);
      return;
    }
    if (v != null && typeof v === 'object') {
      for (const x of Object.values(v as object)) add(x, depth + 1);
    }
  };
  for (const v of values) add(v, 0);
  return [...out];
}

const PEM_OR_AUTH = /-----BEGIN|(^|\s)(Bearer|Basic)\s/i;
const JWT_SHAPE = /eyJ[A-Za-z0-9_-]*\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*/;
const HEX_RUN = /[0-9a-fA-F]{32,}/;
const B64_WHOLE = /^[A-Za-z0-9+/_-]{40,}={0,2}$/;
const B64_RUN = /[A-Za-z0-9+_-]{40,}/g;
const URL_START = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//;
const URL_TOKEN = /[a-zA-Z][a-zA-Z0-9+.-]*:\/\/[^\s,]*/g;
// `user:password@host`, with or without a scheme in front.
// (Not across a comma: lists such as `app@https://host:3000,other@https://host`.)
const USERINFO_SHAPE = /[^\s/?#@:,]+:[^\s/?#@,]*@[^\s@]/;

function mixedClasses (s: string): boolean {
  return /[0-9]/.test(s) && /[A-Z]/.test(s) && /[a-z]/.test(s);
}

/** True when a string must not be shown, whatever its key. */
export function stringLooksSecret (s: string, needles: readonly string[]): boolean {
  for (const needle of needles) {
    if (s.includes(needle)) return true;
  }
  if (PEM_OR_AUTH.test(s) || JWT_SHAPE.test(s) || HEX_RUN.test(s)) return true;
  if (B64_WHOLE.test(s) && !s.startsWith('/') && mixedClasses(s)) return true;
  for (const run of s.match(B64_RUN) ?? []) if (mixedClasses(run)) return true;
  return false;
}

/**
 * The URL of a string that is exactly one URL with a scheme (no surrounding
 * space, parsed by WHATWG URL), or null. A string holding `@` whose parsed
 * URL has no user name is refused too: a `#`, `?` or `/` left unencoded in a
 * password moves it out of the userinfo, where no sanitising would see it.
 */
function parseWholeUrl (s: string): URL | null {
  if (!URL_START.test(s) || /\s/.test(s)) return null;
  let url: URL;
  try {
    url = new URL(s);
  } catch {
    return null;
  }
  if (s.includes('@') && url.username === '') return null;
  return url;
}

/**
 * How a string is shown: unchanged, sanitised (`sanitized: true`), or
 * refused (null: the caller redacts it). Fails closed:
 * - a string that is one URL: userinfo replaced by `***`, every query
 *   parameter by `name=***` (a parameter without value by `***`), `;`
 *   path parameters and the fragment dropped; with `originOnly`, scheme,
 *   host and port only;
 * - with `originOnly`, anything else that is not empty is refused;
 * - a string holding URLs among other text: shown only when each of them is a
 *   plain URL (no userinfo, query, fragment or `;` parameter);
 * - a result still shaped like `user:password@host` is refused.
 */
export function showableString (s: string, originOnly: boolean): { value: string, sanitized: boolean } | null {
  let result: { value: string, sanitized: boolean } | null;
  const whole = parseWholeUrl(s);
  if (whole != null) {
    result = originOnly ? originOf(s, whole) : sanitizeParsed(s, whole);
  } else if (originOnly) {
    result = s === '' ? { value: s, sanitized: false } : null;
  } else if (s.includes('://')) {
    const tokens = s.match(URL_TOKEN) ?? [];
    const plain = tokens.length === s.split('://').length - 1 && tokens.every((t) => {
      const u = parseWholeUrl(t);
      return u != null && !t.includes('@') && !/[?#;]/.test(t);
    });
    result = plain ? { value: s, sanitized: false } : null;
  } else {
    result = { value: s, sanitized: false };
  }
  if (result != null && USERINFO_SHAPE.test(result.value)) return null;
  return result;
}

function originOf (s: string, url: URL): { value: string, sanitized: boolean } {
  const origin = url.protocol + '//' + url.host;
  return origin === s ? { value: s, sanitized: false } : { value: origin, sanitized: true };
}

function sanitizeParsed (s: string, url: URL): { value: string, sanitized: boolean } {
  const hasUserinfo = url.username !== '' || url.password !== '';
  const hasQuery = s.includes('?');
  const hasFragment = s.includes('#');
  const hasPathParams = url.pathname.includes(';');
  if (!hasUserinfo && !hasQuery && !hasFragment && !hasPathParams) return { value: s, sanitized: false };
  if (hasUserinfo) {
    url.username = '***';
    url.password = '';
  }
  url.pathname = url.pathname.replace(/;[^/]*/g, '');
  const params: string[] = [];
  for (const [name, value] of url.searchParams) params.push(value === '' ? '***' : encodeURIComponent(name) + '=***');
  url.search = params.length > 0 ? '?' + params.join('&') : '';
  url.hash = '';
  return { value: url.toString(), sanitized: true };
}
