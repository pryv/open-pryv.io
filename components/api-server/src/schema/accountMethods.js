/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
/**
 * JSON Schema specification of methods data for user information.
 */

const Action = require('./Action');
const helpers = require('./helpers');
const user = require('./user')(Action.READ);

const accountDetails = helpers.object({
  username: user.properties.username,
  email: user.properties.email,
  language: user.properties.language,
  storageUsed: user.properties.storageUsed
}, {
  required: ['username', 'email', 'storageUsed', 'language'],
  additionalProperties: false
});

// TODO: all this will change after user info is moved to profiles (so that users collection only
//       deals with users' status

module.exports = {
  get: {
    params: helpers.object({}),
    result: helpers.object({
      account: accountDetails
    }, {
      required: ['account']
    })
  },

  update: {
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
  },

  changePassword: {
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
  },

  requestPasswordReset: {
    params: helpers.object({
      appId: helpers.string(),
      origin: helpers.string()
    }, {
      required: ['appId']
    }),
    result: helpers.object({}, { additionalProperties: false })
  },

  resetPassword: {
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
  }
};
