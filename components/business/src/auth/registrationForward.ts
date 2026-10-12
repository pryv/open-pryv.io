/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
import crypto from 'node:crypto';

/**
 * A registration forwarded by one core to another carries this header,
 * signed with the key every core of the platform shares (`auth.adminAccessKey`;
 * the key itself never travels). The target creates the account itself
 * (never forwards again) and records the client address the landing core saw.
 */
const REGISTRATION_FORWARD_HEADER = 'pryv-registration-forward';
const MAX_SKEW_MS = 60_000;

type Forward = { from: string; client: string };

function signature (key: string, from: string, client: string, ts: number, body: string): string {
  const bodyHash = crypto.createHash('sha256').update(body).digest('hex');
  return crypto.createHmac('sha256', key).update(['reg-fwd', from, client, String(ts), bodyHash].join('|')).digest('hex');
}

/** The header value for a forward of `body` (the exact JSON sent). */
function signRegistrationForward (key: string, from: string, client: string, body: string, ts: number = Date.now()): string {
  const fields = { from, client, ts: String(ts), sig: signature(key, from, client, ts, body) };
  return 'v1;' + Object.entries(fields).map(([k, v]) => k + '=' + encodeURIComponent(v)).join(';');
}

/** The forward a header proves for `body`, or null (bad format, signature or age). */
function verifyRegistrationForward (header: unknown, key: string, body: string, now: number = Date.now()): Forward | null {
  if (typeof header !== 'string' || !header.startsWith('v1;') || typeof key !== 'string' || key.length === 0) return null;
  const fields: Record<string, string> = {};
  for (const part of header.slice(3).split(';')) {
    const at = part.indexOf('=');
    if (at <= 0) return null;
    try { fields[part.slice(0, at)] = decodeURIComponent(part.slice(at + 1)); } catch { return null; }
  }
  const { from, client, sig } = fields;
  const ts = Number(fields.ts);
  if (from == null || client == null || sig == null || !Number.isFinite(ts) || Math.abs(now - ts) > MAX_SKEW_MS) return null;
  const expected = Buffer.from(signature(key, from, client, ts, body), 'hex');
  const given = Buffer.from(sig, 'hex');
  if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) return null;
  return { from, client };
}

export { REGISTRATION_FORWARD_HEADER, signRegistrationForward, verifyRegistrationForward };
