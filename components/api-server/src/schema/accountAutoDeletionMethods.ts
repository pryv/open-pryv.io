/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
import * as helpers from './helpers.ts';

/**
 * JSON Schema specification of the account auto-deletion methods. The
 * schema bounds the types; the values (date format, bounds, policy) are
 * checked by the method, which names the failing rule.
 */

const get = {
  params: helpers.object({})
};
export { get };

const set = {
  params: helpers.object({
    mode: helpers.string({ enum: ['default', 'never', 'date', 'inactivity'] }),
    date: helpers.string({ maxLength: 40 }),
    inactivityDays: helpers.getBaseSchema('integer', { minimum: 1 }),
    action: helpers.string({ enum: ['delete', 'transfer'] }),
    // Transfer settings (`action: 'transfer'`). None is required here: a
    // transfer refused for its action first says why.
    transfer: helpers.object({
      email: helpers.string({ maxLength: 300 }),
      name: helpers.string({ maxLength: 200 }),
      dateOfBirth: helpers.string({ maxLength: 10 }),
      notifyBeneficiary: helpers.string({ enum: ['atSetup', 'atTrigger'] }),
      fallback: helpers.string({ enum: ['delete', 'keep'] })
    }, { additionalProperties: false }),
    acknowledgeNoReminders: helpers.boolean(),
    password: helpers.string({ maxLength: 1000 })
  }, {
    required: ['mode'],
    additionalProperties: false
  })
};
export { set };

// Public: the token of the mailed link is the credential.
const transferClaim = {
  params: helpers.object({
    appId: helpers.string(),
    origin: helpers.string(),
    token: helpers.string({ maxLength: 200 }),
    // The account claiming (signed in to on its own core, which completes the
    // handshake with `delegations.acceptAttach`).
    claimant: helpers.string({ maxLength: 100 })
  }, {
    required: ['appId', 'token', 'claimant'],
    additionalProperties: false
  })
};
export { transferClaim };

const transferDecline = {
  params: helpers.object({
    appId: helpers.string(),
    origin: helpers.string(),
    token: helpers.string({ maxLength: 200 })
  }, {
    required: ['appId', 'token'],
    additionalProperties: false
  })
};
export { transferDecline };
