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
import { isPlaceholderValue, MIN_SECRET_LENGTH } from '../secretValues.ts';

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

/**
 * The fingerprint key, derived from `auth.filesReadTokenSecret` (required
 * identical on every core, never shown), or null when that secret is too weak
 * to key with: then the document carries no fingerprint at all.
 */
export function fingerprintKey (filesReadTokenSecret: unknown): Buffer | null {
  if (typeof filesReadTokenSecret !== 'string') return null;
  if (isPlaceholderValue(filesReadTokenSecret) || filesReadTokenSecret.length < MIN_SECRET_LENGTH) return null;
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

/** The live secret strings searched for inside every shown string. */
export function secretNeedles (values: unknown[]): string[] {
  const out = new Set<string>();
  const add = (v: unknown, depth: number) => {
    if (depth > 12) return;
    if (typeof v === 'string') {
      if (v.length >= MIN_NEEDLE_LENGTH && !isPlaceholderValue(v)) out.add(v);
      return;
    }
    if (v != null && typeof v === 'object') {
      for (const x of Object.values(v as object)) add(x, depth + 1);
    }
  };
  for (const v of values) add(v, 0);
  return [...out];
}

const PEM_OR_AUTH = /-----BEGIN|^\s*(Bearer|Basic)\s/i;
const JWT_SHAPE = /eyJ[A-Za-z0-9_-]*\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*/;
const HEX_KEY = /^[0-9a-fA-F]{32,}$/;
const B64_KEY = /^[A-Za-z0-9+/_-]{40,}={0,2}$/;
const URL_START = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//;

/** True when a string must not be shown, whatever its key. */
export function stringLooksSecret (s: string, needles: readonly string[]): boolean {
  for (const needle of needles) {
    if (s.includes(needle)) return true;
  }
  if (PEM_OR_AUTH.test(s) || JWT_SHAPE.test(s)) return true;
  if (HEX_KEY.test(s)) return true;
  if (B64_KEY.test(s) && !s.startsWith('/') && /[0-9]/.test(s) && /[A-Z]/.test(s) && /[a-z]/.test(s)) return true;
  return false;
}

/**
 * A URL with any userinfo replaced by `***`, every query value by `***` and
 * no fragment (`sanitized: true`), the string unchanged when it has none of
 * them, or null when the string is not a URL with a scheme.
 */
export function sanitizeUrl (s: string): { value: string, sanitized: boolean } | null {
  if (!URL_START.test(s)) return null;
  let url: URL;
  try {
    url = new URL(s);
  } catch {
    return null;
  }
  const hasUserinfo = url.username !== '' || url.password !== '';
  const hasQuery = s.includes('?');
  const hasFragment = s.includes('#');
  if (!hasUserinfo && !hasQuery && !hasFragment) return { value: s, sanitized: false };
  if (hasUserinfo) {
    url.username = '***';
    url.password = '';
  }
  const names = [...new Set([...url.searchParams.keys()])];
  for (const name of names) url.searchParams.set(name, '***');
  url.hash = '';
  return { value: url.toString(), sanitized: true };
}

/** Scheme, host and port of a URL, or null when it is not one. */
export function urlOrigin (s: string): string | null {
  if (!URL_START.test(s)) return null;
  try {
    const url = new URL(s);
    return url.protocol + '//' + url.host;
  } catch {
    return null;
  }
}
