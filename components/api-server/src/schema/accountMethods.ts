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

const accountDetails = helpers.object({
  username: user.properties.username,
  email: user.properties.email,
  language: user.properties.language,
  storageUsed: user.properties.storageUsed
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
        language: helpers.language
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
