/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { randomUUID: uuidv4 } = require('node:crypto');

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
  recoveryCodes: string[];
  method?: string;
  totp?: TotpState;

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

  generateRecoveryCodes (): void {
    this.recoveryCodes = Array.from({ length: 10 }, () => uuidv4());
  }

  getRecoveryCodes (): string[] {
    return this.recoveryCodes;
  }
}

export default Profile;
export { Profile };