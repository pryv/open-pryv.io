/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
import type {} from 'node:fs';

/**
 * JSON Schema specification of methods data for MFA (multi-factor authentication).
 * Plan 26: merged from service-mfa.
 */

const helpers = require('./helpers');
const object = helpers.object;
const string = helpers.string;
const array = helpers.array;

module.exports = {
  // mfa.activate — start the MFA setup flow.
  // Personal access token required. Body is the profile content (e.g. { phone: '+41...' }) —
  // arbitrary key-value pairs that get templated into the SMS endpoint URL/headers/body.
  activate: {
    params: object({}, {
      additionalProperties: true
    }),
    result: object({
      mfaToken: string()
    }, {
      required: ['mfaToken'],
      additionalProperties: false
    })
  },

  // mfa.confirm — finish activation. Validates the SMS code and persists the MFA profile.
  // Returns 10 recovery codes.
  confirm: {
    params: object({
      mfaToken: string(),
      code: string()
    }, {
      required: ['mfaToken'],
      additionalProperties: true
    }),
    result: object({
      recoveryCodes: array(string())
    }, {
      required: ['recoveryCodes'],
      additionalProperties: false
    })
  },

  // mfa.challenge — re-trigger an SMS challenge for an existing MFA session.
  challenge: {
    params: object({
      mfaToken: string()
    }, {
      required: ['mfaToken'],
      additionalProperties: false
    }),
    result: object({
      message: string()
    }, {
      required: ['message'],
      additionalProperties: false
    })
  },

  // mfa.verify — verify the SMS code; returns the real Pryv access token.
  verify: {
    params: object({
      mfaToken: string(),
      code: string()
    }, {
      required: ['mfaToken'],
      additionalProperties: true
    }),
    result: object({
      token: string(),
      apiEndpoint: string()
    }, {
      required: ['token'],
      additionalProperties: false
    })
  },

  // mfa.deactivate — disable MFA for the calling user. Personal access token required.
  deactivate: {
    params: object({}, {
      additionalProperties: false
    }),
    result: object({
      message: string()
    }, {
      required: ['message'],
      additionalProperties: false
    })
  },

  // mfa.recover — disable MFA using a recovery code (no MFA challenge required).
  // Validates username + password + recoveryCode.
  recover: {
    params: object({
      username: helpers.username,
      password: string(),
      recoveryCode: string()
    }, {
      required: ['username', 'password', 'recoveryCode'],
      additionalProperties: false
    }),
    result: object({
      message: string()
    }, {
      required: ['message'],
      additionalProperties: false
    })
  }
};
