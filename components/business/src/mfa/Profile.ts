/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const crypto = require('node:crypto');
const { randomUUID: uuidv4 } = crypto;

/** Marks a stored recovery code as a digest rather than the code itself. */
const HASHED_PREFIX = 'sha256:';

/**
 * Digest a recovery code for storage.
 *
 * A plain SHA-256 is the right primitive here, not a password KDF: these codes
 * are 122-bit random values, so there is no guessable keyspace for a slow hash
 * to defend, and a KDF would only add latency to every verification.
 */
function hashRecoveryCode (code: string): string {
  return HASHED_PREFIX + crypto.createHash('sha256').update(code, 'utf8').digest('hex');
}

/** True when a stored entry is a digest (as opposed to a legacy plain code). */
function isHashedRecoveryCode (stored: string): boolean {
  return stored.startsWith(HASHED_PREFIX);
}

/**
 * MFA profile model: the per-user state stored in the user's private profile
 * under `profile.mfa = { method?, content, recoveryCodes, totp? }`.
 *
 * - `method`: the active MFA method, `'sms'` or `'totp'`. Absent reads as
 *   `'sms'` (legacy profiles pre-date the field).
 * - `content`: arbitrary key-value pairs supplied at activation time and used as
 *   template substitutions for SMS endpoint URLs/headers/bodies (e.g. phone number).
 * - `recoveryCodes`: 10 UUID v4 strings generated on activation confirmation; each
 *   one allows the user to deactivate MFA without going through the challenge.
 * - `totp`: present for TOTP enrolments; the secret is stored encrypted at rest.
 *   `confirmedAt` is null until `mfa.confirm` succeeds (a pending secret is never
 *   usable at login); `lastUsedStep` is the replay guard.
 */
type TotpState = {
  secret: string; // AtRestEncryption envelope, never plaintext
  algorithm: string;
  digits: number;
  periodSeconds: number;
  confirmedAt: number | null;
  lastUsedStep: number;
};

class Profile {
  content: Record<string, unknown>;
  /** As stored: digests for anything generated since hashing landed. */
  recoveryCodes: string[];
  method?: string;
  totp?: TotpState;
  /**
   * The freshly generated codes in the clear, held only for the response that
   * shows them to the user once. Never assigned when a profile is read back
   * from storage, and never persisted.
   */
  #plainRecoveryCodes: string[] = [];

  constructor (content: Record<string, unknown> = {}, recoveryCodes: string[] = [], method?: string, totp?: TotpState) {
    this.content = content;
    this.recoveryCodes = recoveryCodes;
    if (method !== undefined) this.method = method;
    if (totp !== undefined) this.totp = totp;
  }

  isActive (): boolean {
    if (this.method === 'totp') return !!(this.totp && this.totp.confirmedAt);
    return Object.keys(this.content).length > 0;
  }

  /**
   * Mint 10 codes. Only their digests are kept on the profile; the codes
   * themselves live on this instance just long enough to be returned to the
   * user, which is the single moment they can ever be read.
   */
  generateRecoveryCodes (): void {
    const plain = Array.from({ length: 10 }, () => uuidv4());
    this.#plainRecoveryCodes = plain;
    this.recoveryCodes = plain.map(hashRecoveryCode);
  }

  /**
   * The codes to show the user, available only on the instance that just
   * generated them. A profile loaded from storage holds digests and returns
   * nothing here, so a stored code can never be handed back out.
   */
  getRecoveryCodes (): string[] {
    return this.#plainRecoveryCodes;
  }

  /**
   * Constant-time check of a supplied code against every stored entry, with no
   * short-circuit, so neither the timing nor the position of a match leaks.
   *
   * Accepts both shapes: digests, and codes stored in the clear by an older
   * version. Legacy entries are compared directly; they disappear on their own,
   * since the only successful use of a recovery code removes the enrolment that
   * holds them.
   */
  matchesRecoveryCode (supplied: unknown): boolean {
    const suppliedStr = String(supplied ?? '');
    const suppliedPlain = Buffer.from(suppliedStr, 'utf8');
    const suppliedHashed = Buffer.from(hashRecoveryCode(suppliedStr), 'utf8');
    let matched = false;
    for (const stored of this.recoveryCodes) {
      const storedBuf = Buffer.from(stored, 'utf8');
      const candidate = isHashedRecoveryCode(stored) ? suppliedHashed : suppliedPlain;
      if (storedBuf.length === candidate.length && crypto.timingSafeEqual(storedBuf, candidate)) {
        matched = true;
      }
    }
    return matched;
  }
}

export default Profile;
export { Profile, hashRecoveryCode, isHashedRecoveryCode };