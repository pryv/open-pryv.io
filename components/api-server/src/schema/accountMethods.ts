/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
/**
 * JSON Schema specification of methods data for user information.
 */

const Action = require('./Action.ts');
const helpers = require('./helpers.ts');
const user = require('./user.ts').default(Action.READ);

// One entry per email in the account's `:_emails:` container (the primary
// included). The legacy scalar `email` above stays authoritative for the
// primary; this array is the parallel multi-email record.
const emailEntry = helpers.object({
  value: helpers.email,
  primary: helpers.boolean(),
  status: helpers.string({ enum: ['pending', 'verified'] }),
  verifiedAt: helpers.number({ nullable: true }),
  // Explicit provenance. `null` is grandfathered pre-provenance data (read-only);
  // only 'email-link' / 'operator' count as proved ownership.
  verificationMethod: helpers.string({ nullable: true, enum: ['email-link', 'operator', 'registration', 'legacy', null] })
}, {
  required: ['value', 'primary', 'status', 'verifiedAt', 'verificationMethod'],
  additionalProperties: false
});

const accountDetails = helpers.object({
  username: user.properties.username,
  email: user.properties.email,
  language: user.properties.language,
  storageUsed: user.properties.storageUsed,
  emails: helpers.array(emailEntry)
}, {
  required: ['username', 'email', 'storageUsed', 'language'],
  additionalProperties: false
});

const __ex_get = {
    params: helpers.object({}),
    result: helpers.object({
      account: accountDetails
    }, {
      required: ['account']
    })
  };
export { __ex_get as get };
const __ex_update = {
    params: helpers.object({
      // = body of HTTP requests
      update: helpers.object({
        email: helpers.email,
        language: helpers.language,
        // Multi-email operations, applied in the order add, setPrimary, remove.
        emails: helpers.object({
          // Bounded per request (the hard ceiling on emails per account is 20)
          // so one call cannot fan out an unbounded number of verification mails.
          add: helpers.array(helpers.email, { maxItems: 20 }),
          remove: helpers.array(helpers.email, { maxItems: 20 }),
          setPrimary: helpers.email,
          // Re-send the verification mail for pending addresses (cooldown-gated).
          resend: helpers.array(helpers.email, { maxItems: 20 })
        }, { additionalProperties: false })
      }, { additionalProperties: false })
    }, {
      required: ['update']
    }),
    result: helpers.object({
      account: accountDetails
    }, {
      required: ['account']
    })
  };
export { __ex_update as update };
const __ex_changePassword = {
    params: helpers.object({
      oldPassword: helpers.string(),
      newPassword: helpers.string({
        minLength: 6,
        maxLength: 100
      })
    }, {
      required: ['oldPassword', 'newPassword'],
      additionalProperties: false
    }),
    result: helpers.object({}, { additionalProperties: false })
  };
export { __ex_changePassword as changePassword };
const __ex_requestPasswordReset = {
    params: helpers.object({
      appId: helpers.string(),
      origin: helpers.string()
    }, {
      required: ['appId']
    }),
    result: helpers.object({}, { additionalProperties: false })
  };
export { __ex_requestPasswordReset as requestPasswordReset };
const __ex_resetPassword = {
    params: helpers.object({
      appId: helpers.string(),
      origin: helpers.string(),
      resetToken: helpers.string(),
      newPassword: helpers.string({
        minLength: 6,
        maxLength: 100
      })
    }, {
      required: ['appId', 'resetToken', 'newPassword']
    }),
    result: helpers.object({}, { additionalProperties: false })
  };
export { __ex_resetPassword as resetPassword };
const __ex_verifyEmail = {
    params: helpers.object({
      appId: helpers.string(),
      origin: helpers.string(),
      token: helpers.string()
    }, {
      required: ['appId', 'token']
    }),
    result: helpers.object({
      email: helpers.email
    }, {
      required: ['email'],
      additionalProperties: false
    })
  };
export { __ex_verifyEmail as verifyEmail };
const __ex_changeUsername = {
    params: helpers.object({
      newUsername: user.properties.username
    }, {
      required: ['newUsername'],
      additionalProperties: false
    }),
    result: helpers.object({
      account: accountDetails,
      usernameChangesRemaining: helpers.number()
    }, {
      required: ['account', 'usernameChangesRemaining']
    })
  };
export { __ex_changeUsername as changeUsername };
const __ex_usernameChanges = {
    params: helpers.object({}),
    result: helpers.object({
      usernameChangesRemaining: helpers.number(),
      usernameChangesLimit: helpers.number(),
      usernameChangesUsed: helpers.number()
    }, {
      required: ['usernameChangesRemaining', 'usernameChangesLimit', 'usernameChangesUsed']
    })
  };
export { __ex_usernameChanges as usernameChanges };
