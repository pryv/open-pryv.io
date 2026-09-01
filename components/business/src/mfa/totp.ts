/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const crypto = require('node:crypto');

/**
 * In-process TOTP / HOTP primitive (no external dependency).
 *
 * - HOTP per RFC 4226 (HMAC-SHA1 + dynamic truncation).
 * - TOTP per RFC 6238 (time-stepped HOTP).
 * - Base32 per RFC 4648, emitted WITHOUT padding (the otpauth URI form
 *   authenticator apps expect); decoding tolerates padding, whitespace and
 *   lower case.
 *
 * Verification is constant-time (`crypto.timingSafeEqual`) and returns the
 * accepted time step so the caller can persist it as a replay guard. Pinned by
 * the RFC golden vectors in `test/fixtures/totp-vectors.json`.
 */

const B32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/** RFC 4648 Base32 encode, no padding, uppercase. */
function base32Encode (buf: Buffer): string {
  if (buf.length === 0) return '';
  let bits = 0;
  let value = 0;
  let out = '';
  for (let i = 0; i < buf.length; i++) {
    value = (value << 8) | buf[i];
    bits += 8;
    while (bits >= 5) {
      out += B32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32_ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

/** RFC 4648 Base32 decode; tolerant of padding, whitespace and lower case. */
function base32Decode (str: string): Buffer {
  const clean = String(str).toUpperCase().replace(/=+$/, '').replace(/\s+/g, '');
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const idx = B32_ALPHABET.indexOf(ch);
    if (idx === -1) throw new Error(`base32Decode: invalid character "${ch}"`);
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** 8-byte big-endian counter buffer (RFC 4226); BigInt-safe for large steps. */
function counterToBuffer (counter: number | bigint): Buffer {
  const buf = Buffer.alloc(8);
  let big = BigInt(counter);
  for (let i = 7; i >= 0; i--) {
    buf[i] = Number(big & 0xffn);
    big >>= 8n;
  }
  return buf;
}

/**
 * HOTP value (RFC 4226) for a counter, as a zero-padded decimal string.
 *
 * @param key - the shared secret as raw bytes
 * @param counter - moving factor
 * @param digits - output length (default 6)
 * @param algorithm - HMAC hash (default 'sha1', the authenticator-app baseline)
 */
function hotp (key: Buffer, counter: number | bigint, digits = 6, algorithm = 'sha1'): string {
  const hmac: Buffer = crypto.createHmac(algorithm, key).update(counterToBuffer(counter)).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const binary = ((hmac[offset] & 0x7f) << 24) |
    ((hmac[offset + 1] & 0xff) << 16) |
    ((hmac[offset + 2] & 0xff) << 8) |
    (hmac[offset + 3] & 0xff);
  const otp = binary % (10 ** digits);
  return otp.toString().padStart(digits, '0');
}

/** Time step index for an epoch-seconds instant (RFC 6238). */
function stepFor (timeSeconds: number, t0 = 0, periodSeconds = 30): number {
  return Math.floor((timeSeconds - t0) / periodSeconds);
}

type TotpCodeOpts = {
  time?: number; // epoch seconds; default now
  t0?: number;
  periodSeconds?: number;
  digits?: number;
  algorithm?: string;
};

/** TOTP value (RFC 6238) for an instant. */
function totpCode (key: Buffer, opts: TotpCodeOpts = {}): string {
  const { time = Math.floor(Date.now() / 1000), t0 = 0, periodSeconds = 30, digits = 6, algorithm = 'sha1' } = opts;
  return hotp(key, stepFor(time, t0, periodSeconds), digits, algorithm);
}

type TotpVerifyOpts = {
  digits?: number;
  periodSeconds?: number;
  driftSteps?: number; // accept +/- N steps around now
  t0?: number;
  algorithm?: string;
  now?: number; // epoch seconds; default Date.now()
  notAfterOrAtStep?: number | null; // replay guard: reject steps <= this
};

/**
 * Verify a submitted TOTP code within a drift window. Returns the accepted time
 * step (so the caller can persist it as `lastUsedStep`), or null on failure.
 * Comparison is constant-time. A code whose length does not match `digits` is
 * rejected without an HMAC computation.
 */
function totpVerify (key: Buffer, code: string, opts: TotpVerifyOpts = {}): number | null {
  const {
    digits = 6, periodSeconds = 30, driftSteps = 1, t0 = 0, algorithm = 'sha1',
    now = Math.floor(Date.now() / 1000), notAfterOrAtStep = null
  } = opts;
  if (typeof code !== 'string') return null;
  const candidate = code.trim();
  if (candidate.length !== digits || !/^\d+$/.test(candidate)) return null;
  const candidateBuf = Buffer.from(candidate, 'utf8');
  const currentStep = stepFor(now, t0, periodSeconds);
  for (let s = currentStep - driftSteps; s <= currentStep + driftSteps; s++) {
    if (s < 0) continue;
    if (notAfterOrAtStep != null && s <= notAfterOrAtStep) continue; // replay guard
    const expected = Buffer.from(hotp(key, s, digits, algorithm), 'utf8');
    if (expected.length === candidateBuf.length && crypto.timingSafeEqual(expected, candidateBuf)) {
      return s;
    }
  }
  return null;
}

export { base32Encode, base32Decode, hotp, totpCode, totpVerify, stepFor };
