/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

/**
 * JSON Schema specification of methods data for MFA (multi-factor authentication).
 */

const helpers = require('./helpers.ts');
const object = helpers.object;
const string = helpers.string;
const array = helpers.array;
const { CODE_PATTERN, PHONE_PATTERN } = require('business/src/mfa/smsRequest.ts');

/** An MFA code: 4 to 10 digits. */
const mfaCode = string({ pattern: CODE_PATTERN.source });

const mfaMethods = {
  // mfa.activate — start the MFA setup flow.
  // Personal access token required. For SMS the body is the enrolment content:
  // `phone` (E.164), plus the keys the operator allow-lists in
  // services.mfa.methods.sms.contentKeys, all strings; the method refuses any
  // other key, and a TOTP enrolment takes none. Over an active enrolment it
  // also needs a step-up (`password` or `code`, as for mfa.deactivate); those
  // two keys are never enrolment content, and their type is checked by the
  // step-up itself.
  activate: {
    params: object({
      method: string(), // optional: 'totp' | 'sms'; defaults to services.mfa.defaultMethod
      password: {},
      code: {},
      phone: string({ pattern: PHONE_PATTERN.source })
    }, {
      additionalProperties: string() // allow-listed SMS content keys, checked by the method
    }),
    result: object({
      mfaToken: string(),
      method: string(), // TOTP enrolments echo the method + enrolment material
      otpauthUri: string(),
      secret: string()
    }, {
      required: ['mfaToken'],
      additionalProperties: false
    })
  },

  // mfa.confirm: finish activation. Validates the code and persists the MFA profile.
  // Returns 10 recovery codes. Only `code` is used from the body.
  confirm: {
    params: object({
      mfaToken: string(),
      code: mfaCode
    }, {
      required: ['mfaToken', 'code'],
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
      message: string(),
      method: string() // present so clients can render the right prompt
    }, {
      required: ['message'],
      additionalProperties: false
    })
  },

  // mfa.verify: verify the code; returns the real Pryv access token. Only
  // `code` is used from the body.
  verify: {
    params: object({
      mfaToken: string(),
      code: mfaCode
    }, {
      required: ['mfaToken', 'code'],
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

  // mfa.deactivate: disable MFA for the calling user. Personal access token
  // required, plus a step-up: either `password` (the account password) or
  // `code` (a code of the current TOTP factor). Which one is present is
  // checked by the method, since services.mfa.stepUp.required can lift it.
  deactivate: {
    params: object({
      password: string(),
      code: string()
    }, {
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
export default mfaMethods;
export const activate = mfaMethods.activate;
export const confirm = mfaMethods.confirm;
export const challenge = mfaMethods.challenge;
export const verify = mfaMethods.verify;
export const deactivate = mfaMethods.deactivate;
export const recover = mfaMethods.recover;
