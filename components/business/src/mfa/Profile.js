/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

const { v4: uuidv4 } = require('uuid');

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
  /** @type {Object} */
  content;
  /** @type {string[]} */
  recoveryCodes;

  constructor (content = {}, recoveryCodes = []) {
    this.content = content;
    this.recoveryCodes = recoveryCodes;
  }

  isActive () {
    return Object.keys(this.content).length > 0;
  }

  generateRecoveryCodes () {
    this.recoveryCodes = Array.from({ length: 10 }, () => uuidv4());
  }

  getRecoveryCodes () {
    return this.recoveryCodes;
  }
}

module.exports = Profile;
