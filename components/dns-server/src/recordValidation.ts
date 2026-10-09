/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/**
 * Validation for stored DNS records (the PlatformDB / config `staticEntries`
 * shape: a subdomain key and an object with `a` / `aaaa` / `cname` / `txt`).
 * One source of truth used by every write path (admin route, Platform wrapper,
 * the records CLI, runtime updates) and at refresh/serve time, so a record of
 * the wrong shape is rejected where it enters rather than throwing deep inside
 * the wire encoder.
 */

import { isIPv4, isIPv6 } from 'node:net';

/** A character-string in a TXT record is at most 255 octets (RFC 1035 section 3.3.14). */
export const MAX_CHARACTER_STRING = 255;

/** Upper bound on a single TXT value before it is split into character-strings. */
export const MAX_TXT_BYTES = 2048;

/**
 * Upper bounds on the number of values a stored entry may carry: per key
 * (`a`, `aaaa`, `txt`) and for all keys of one subdomain together. The wire
 * encoder's cost grows faster than linearly with the record count of an
 * answer, and a UDP answer truncates long before these numbers anyway.
 */
export const MAX_VALUES_PER_KEY = 32;
export const MAX_VALUES_PER_SUBDOMAIN = 64;

/** A DNS name label is at most 63 octets; the whole name at most 253 presentation octets. */
const MAX_LABEL = 63;
const MAX_NAME = 253;

/** Subdomain / host labels: lowercase letters, digits, hyphen, underscore. */
const LABEL_RE = /^[a-z0-9_-]+$/;

/** A built dns2 answer object, enumerated across the record types this server emits. */
export type EncodableAnswer = {
  type: number;
  name?: string;
  address?: string;
  domain?: string;
  data?: string | string[];
  ns?: string;
  exchange?: string;
  priority?: number;
  primary?: string;
  admin?: string;
  serial?: number;
  refresh?: number;
  retry?: number;
  expiration?: number;
  minimum?: number;
  tag?: string;
  value?: string;
};

const KNOWN_KEYS = ['a', 'aaaa', 'cname', 'txt'];

/**
 * True when every label of `name` is lowercase LDH-plus-underscore, no label
 * exceeds 63 octets and the whole name is at most 253 octets. Used for both
 * subdomain keys and CNAME targets.
 */
function isValidName (name: string): boolean {
  if (typeof name !== 'string' || name.length === 0 || name.length > MAX_NAME) return false;
  const labels = name.split('.');
  for (const label of labels) {
    if (label.length === 0 || label.length > MAX_LABEL) return false;
    if (!LABEL_RE.test(label)) return false;
  }
  return true;
}

export function isValidSubdomain (subdomain: unknown): boolean {
  return typeof subdomain === 'string' && isValidName(subdomain);
}

function asArray (v: string | string[]): string[] {
  return Array.isArray(v) ? v : [v];
}

/**
 * Validate a stored DNS record entry. Returns a list of human-readable
 * problems; an empty list means the entry is valid. Every present key must be
 * one of `a` / `aaaa` / `cname` / `txt`, at least one must be present, and each
 * value must match its type.
 */
export function validateDnsRecord (subdomain: unknown, records: unknown): string[] {
  const errors: string[] = [];
  if (!isValidSubdomain(subdomain)) {
    errors.push('subdomain must be lowercase letters, digits, hyphen or underscore (labels <= 63, total <= 253)');
  }
  if (records == null || typeof records !== 'object' || Array.isArray(records)) {
    errors.push('records must be an object');
    return errors;
  }
  const rec = records as Record<string, unknown>;
  const keys = Object.keys(rec);
  const unknown = keys.filter((k) => !KNOWN_KEYS.includes(k));
  if (unknown.length > 0) {
    errors.push(`unknown record key(s): ${unknown.join(', ')} (allowed: ${KNOWN_KEYS.join(', ')})`);
  }
  if (keys.filter((k) => KNOWN_KEYS.includes(k)).length === 0) {
    errors.push(`no recognised record data (expected one of: ${KNOWN_KEYS.join(', ')})`);
  }

  // Count first: an oversized list is refused as a whole, without a problem
  // per value.
  let total = rec.cname != null ? 1 : 0;
  const tooMany = new Set<string>();
  for (const key of ['a', 'aaaa', 'txt']) {
    const v = rec[key];
    if (v == null || !isStringOrStringArray(v)) continue;
    const count = asArray(v as string | string[]).length;
    total += count;
    if (count > MAX_VALUES_PER_KEY) {
      tooMany.add(key);
      errors.push(`${key} may hold at most ${MAX_VALUES_PER_KEY} values (got ${count})`);
    }
  }
  if (total > MAX_VALUES_PER_SUBDOMAIN) {
    errors.push(`a subdomain may hold at most ${MAX_VALUES_PER_SUBDOMAIN} values in all (got ${total})`);
  }

  if (rec.a != null) {
    if (!isStringOrStringArray(rec.a)) errors.push('a must be a string or array of strings');
    else if (!tooMany.has('a')) for (const v of asArray(rec.a as string | string[])) if (!isIPv4(v)) errors.push(`a: '${v}' is not an IPv4 address`);
  }
  if (rec.aaaa != null) {
    if (!isStringOrStringArray(rec.aaaa)) errors.push('aaaa must be a string or array of strings');
    else if (!tooMany.has('aaaa')) for (const v of asArray(rec.aaaa as string | string[])) if (!isIPv6(v)) errors.push(`aaaa: '${v}' is not an IPv6 address`);
  }
  if (rec.cname != null) {
    if (typeof rec.cname !== 'string' || !isValidName(rec.cname)) errors.push('cname must be a valid host name');
  }
  if (rec.txt != null) {
    if (!isStringOrStringArray(rec.txt)) {
      errors.push('txt must be a string or array of strings');
    } else if (!tooMany.has('txt')) {
      for (const v of asArray(rec.txt as string | string[])) {
        if (Buffer.byteLength(v, 'utf8') > MAX_TXT_BYTES) errors.push(`txt value exceeds ${MAX_TXT_BYTES} bytes`);
      }
    }
  }
  return errors;
}

function isStringOrStringArray (v: unknown): boolean {
  if (typeof v === 'string') return true;
  return Array.isArray(v) && v.every((x) => typeof x === 'string');
}

/**
 * Split a TXT value into <= 255-octet character-strings (RFC 1035 section
 * 3.3.14). A short string returns a single-element array.
 */
export function toCharacterStrings (value: string): string[] {
  const buf = Buffer.from(value, 'utf8');
  if (buf.length <= MAX_CHARACTER_STRING) return [value];
  const chunks: string[] = [];
  for (let i = 0; i < buf.length; i += MAX_CHARACTER_STRING) {
    chunks.push(buf.subarray(i, i + MAX_CHARACTER_STRING).toString('utf8'));
  }
  return chunks;
}

/**
 * Serve-time shape check on a built dns2 answer object: the fields the wire
 * encoder will touch must be the right primitive type (and IP addresses must
 * parse), so a stray record is skipped rather than throwing mid-encode. Types
 * not produced by this server pass through unchecked.
 */
export function isEncodableAnswer (answer: EncodableAnswer): boolean {
  // dns2 Packet.TYPE values (RFC 1035 section 3.2.2).
  switch (answer.type) {
    case 0x01: // A
      return typeof answer.address === 'string' && isIPv4(answer.address);
    case 0x1c: // AAAA
      return typeof answer.address === 'string' && isIPv6(answer.address);
    case 0x05: // CNAME
      return typeof answer.domain === 'string' && answer.domain.length > 0;
    case 0x10: // TXT
      return typeof answer.data === 'string' ||
        (Array.isArray(answer.data) && answer.data.every((s) => typeof s === 'string'));
    case 0x02: // NS
      return typeof answer.ns === 'string' && answer.ns.length > 0;
    case 0x0f: // MX
      return typeof answer.exchange === 'string' && Number.isInteger(answer.priority);
    case 0x06: // SOA
      return typeof answer.primary === 'string' && typeof answer.admin === 'string' &&
        [answer.serial, answer.refresh, answer.retry, answer.expiration, answer.minimum]
          .every((n) => Number.isFinite(n));
    case 0x101: // CAA
      return typeof answer.tag === 'string' && typeof answer.value === 'string';
    default:
      return true;
  }
}
