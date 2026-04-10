/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

const request = require('superagent');
const { getLogger } = require('@pryv/boiler');
const errors = require('errors').factory;

/**
 * Base class for MFA services. Subclasses (`ChallengeVerifyService`,
 * `SingleService`) implement the actual challenge / verify flows against
 * external SMS provider endpoints.
 *
 * Configuration is injected at construction time as a plain object — easier
 * to test and decouples from the boiler config singleton. The `mfaConfig`
 * shape mirrors `services.mfa` from `default-config.yml`.
 *
 * Session storage is intentionally NOT in this class — see `SessionStore` for
 * the in-memory mfaToken → session map shared across MFA service instances.
 */
class Service {
  /**
   * @param {Object} mfaConfig - the `services.mfa` config block
   */
  constructor (mfaConfig) {
    this.config = mfaConfig;
    this.logger = getLogger('mfa-service');
  }

  /**
   * @param {string} username
   * @param {Profile} profile
   * @param {Object} clientRequest - { headers, body, ... } — the MFA HTTP request context
   * @returns {Promise<void>}
   */
  async challenge (_username, _profile, _clientRequest) {
    throw new Error('override challenge() in a Service subclass');
  }

  /**
   * @param {string} username
   * @param {Profile} profile
   * @param {Object} clientRequest
   * @returns {Promise<void>}
   */
  async verify (_username, _profile, _clientRequest) {
    throw new Error('override verify() in a Service subclass');
  }

  /**
   * Make a POST or GET request to an SMS provider endpoint.
   * @param {'GET'|'POST'} method
   * @param {string} url
   * @param {Object} headers
   * @param {string|Object} body
   * @returns {Promise<superagent.Response>}
   */
  async _makeRequest (method, url, headers, body) {
    try {
      if (method === 'POST') {
        return await request.post(url).set(headers).send(body);
      }
      return await request.get(url).set(headers);
    } catch (error) {
      this.logger.error(
        `MFA SMS provider request failed: ${method} ${url}`,
        { error: error.message, body: error.response?.body }
      );
      throw errors.invalidOperation(
        `MFA SMS provider error: ${error.message}`,
        { id: 'mfa-sms-provider-error' }
      );
    }
  }
}

/**
 * Substitute `{{ key }}` placeholders in a string. Convenience over
 * `String.prototype.replaceAll` so callers can pass a plain key.
 */
Service.replaceAll = function replaceAll (text, key, value) {
  if (typeof text !== 'string') return text;
  return text.split(`{{ ${key} }}`).join(value);
};

/**
 * Walk an object tree and replace `{{ key }}` placeholders inside any string
 * leaves. Returns a deep clone — input is not mutated.
 */
Service.replaceRecursively = function replaceRecursively (obj, key, value) {
  if (obj == null) return obj;
  if (typeof obj === 'string') return Service.replaceAll(obj, key, value);
  if (Array.isArray(obj)) return obj.map(item => Service.replaceRecursively(item, key, value));
  if (typeof obj === 'object') {
    const out = {};
    for (const k of Object.keys(obj)) {
      out[k] = Service.replaceRecursively(obj[k], key, value);
    }
    return out;
  }
  return obj;
};

module.exports = Service;
