/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/**
 * Encryption helper functions (wraps bcrypt functionality for hashing).
 */
import { createRequire } from 'node:module';
import { createLimiter } from './concurrencyLimit.ts';
const require = createRequire(import.meta.url);

const bcrypt = require('bcrypt');
const crypto = require('crypto');
/**
 * bcrypt cost factor. Passed as a NUMBER on every call, so bcrypt generates a
 * fresh salt for each hash (a salt string would be reused verbatim). The
 * development value is bcrypt's minimum cost.
 */
const COST = process.env.NODE_ENV === 'development' ? 4 : 10;

/**
 * Every bcrypt hash and compare of the process (account passwords, the
 * password history, OAuth client secrets) takes one slot of this limiter for
 * the duration of that one call: bcrypt work runs on the thread pool and
 * costs CPU, and a flood of password checks must not starve the rest of the
 * process (file I/O, DNS, compression). Configured by the API workers at
 * start (`configureBcryptLimit`); unconfigured it is a pass-through. A call
 * refused for capacity throws a `CapacityRefusal` and never hashes.
 */
const bcryptLimiter = createLimiter('password check');

/** Longest a bcrypt call waits for a slot before it is refused. */
const BCRYPT_MAX_WAIT_MS = 10 * 1000;
/** What a refused call tells the client to wait. */
const BCRYPT_RETRY_AFTER_SECONDS = 5;

/**
 * @param limits null (or concurrency 0) for no limit.
 */
function configureBcryptLimit (limits: { concurrency: number; queue: number; maxWaitMs?: number } | null): void {
  bcryptLimiter.configure(limits == null
    ? null
    : {
        concurrency: limits.concurrency,
        queue: limits.queue,
        maxWaitMs: limits.maxWaitMs ?? BCRYPT_MAX_WAIT_MS,
        retryAfterSeconds: BCRYPT_RETRY_AFTER_SECONDS
      });
}

/**
 * Runs one bcrypt call in a slot of the shared limiter. For bcrypt callers
 * outside this module (they keep their own cost factor).
 */
async function withBcryptSlot<T> (work: () => Promise<T>): Promise<T> {
  return await bcryptLimiter.run(work);
}

/** Slots in use and calls waiting (tests and diagnostics). */
function bcryptLimitStats (): { running: number; waiting: number } {
  return bcryptLimiter.stats();
}

/**
 * @param value The value to be hashed.
 */
async function hash (value: string): Promise<string> {
  return await bcryptLimiter.run(() => bcrypt.hash(value, COST));
}

/**
 * For tests only.
 */
function hashSync (value: string): string {
  return bcrypt.hashSync(value, COST);
}

/**
 * @param value The value to check
 * @param hash The hash to check the value against
 */
async function compare (value: string, hash: string): Promise<boolean> {
  return await bcryptLimiter.run(() => bcrypt.compare(value, hash));
}

/**
 * Computes the given file's read token for the given access and server secret.
 */
function fileReadToken (fileId: string, accessId: string, accessToken: string, secret: string): string {
  return accessId + '-' + getFileHMAC(fileId, accessToken, secret);
}

/**
 * Extracts the parts from the given file read token.
 */
function parseFileReadToken (fileReadToken: string): { accessId?: string; hmac?: string } {
  const sepIndex = fileReadToken.indexOf('-');
  if (sepIndex <= 0) {
    return {};
  }
  return {
    accessId: fileReadToken.substr(0, sepIndex),
    hmac: fileReadToken.substr(sepIndex + 1)
  };
}

/**
 * With the access id public, the HMAC is the whole credential: compared in
 * constant time.
 */
function isFileReadTokenHMACValid (hmac: string | null | undefined, fileId: string, token: string, secret: string): boolean {
  if (typeof hmac !== 'string') return false;
  const given = Buffer.from(hmac);
  const expected = Buffer.from(getFileHMAC(fileId, token, secret));
  return given.length === expected.length && crypto.timingSafeEqual(given, expected);
}

function getFileHMAC (fileId: string, token: string, secret: string): string {
  const hmac = crypto.createHmac('sha1', secret);
  hmac.setEncoding('base64');
  hmac.write(fileId + '-' + token);
  hmac.end();
  const base64HMAC = hmac.read();
  if (base64HMAC == null) { throw new Error('AF: HMAC cannot be null'); }
  return base64HMAC
    .toString()
    .replace(/\//g, '_')
    .replace(/\+/g, '-')
    .replace(/=/g, '');
}

export {
  hash, hashSync, compare, fileReadToken, parseFileReadToken, isFileReadTokenHMACValid,
  configureBcryptLimit, withBcryptSlot, bcryptLimitStats
};
