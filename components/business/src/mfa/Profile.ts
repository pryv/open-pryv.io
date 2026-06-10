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
 * under `profile.mfa = { content, recoveryCodes }`.
 *
 * - `content`: arbitrary key-value pairs supplied at activation time and used as
 *   template substitutions for SMS endpoint URLs/headers/bodies (e.g. phone number).
 * - `recoveryCodes`: 10 UUID v4 strings generated on activation confirmation; each
 *   one allows the user to deactivate MFA without going through the SMS challenge.
 */
class Profile {
  content: Record<string, unknown>;
  recoveryCodes: string[];

  constructor (content: Record<string, unknown> = {}, recoveryCodes: string[] = []) {
    this.content = content;
    this.recoveryCodes = recoveryCodes;
  }

  isActive (): boolean {
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