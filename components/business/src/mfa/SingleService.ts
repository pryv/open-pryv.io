/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
import type {} from 'node:fs';


const Service = require('./Service');
const generateCode = require('./generateCode');
const errors = require('errors').factory;

const CODE_LENGTH = 4;
const CODE = 'code';

/**
 * Single-endpoint SMS MFA: service-core generates the code itself, sends it
 * via one HTTP call (the SMS provider just delivers it), and validates the
 * verify request locally against the in-memory username -> code map.
 *
 * The username -> code map is per-instance and TTL-bound (matching the
 * session TTL); no cross-instance sharing in single-core deployments.
 */
class SingleService extends Service {
  constructor (mfaConfig) {
    super(mfaConfig);
    const single = mfaConfig.sms.endpoints.single;
    this.url = single.url;
    this.apiMethod = single.method;
    this.headers = single.headers;
    this.body = single.body;
    /** @type {Map<string, string>} username -> code */
    this.codes = new Map();
    /** @type {Map<string, NodeJS.Timeout>} */
    this.timeouts = new Map();
    this.ttlMilliseconds = (mfaConfig.sessions?.ttlSeconds ?? 1800) * 1000;
  }

  async challenge (username, profile, _clientRequest) {
    const code = await generateCode(CODE_LENGTH);
    this.setCode(username, code);
    // Make the code available alongside profile.content for templating.
    const replacements = Object.assign({}, profile.content, { [CODE]: code });
    let url = this.url;
    let headers = this.headers;
    let body = this.body;
    for (const [key, value] of Object.entries(replacements)) {
      headers = Service.replaceRecursively(headers, key, value);
      body = Service.replaceAll(body, key, value);
      url = Service.replaceAll(url, key, value);
    }
    await this._makeRequest(this.apiMethod, url, headers, body);
  }

  async verify (username, _profile, clientRequest) {
    const code = this.codes.get(username);
    if (code !== clientRequest.body.code) {
      throw errors.invalidParametersFormat(
        `The provided MFA code is invalid: ${clientRequest.body.code}`,
        { id: 'invalid-mfa-code' }
      );
    }
    this.clearCode(username);
  }

  setCode (username, code) {
    this.codes.set(username, code);
    this.timeouts.set(
      username,
      setTimeout(() => this.clearCode(username), this.ttlMilliseconds)
    );
  }

  clearCode (username) {
    this.codes.delete(username);
    const t = this.timeouts.get(username);
    if (t) {
      clearTimeout(t);
      this.timeouts.delete(username);
    }
  }
}

SingleService.CODE = CODE;
module.exports = SingleService;
