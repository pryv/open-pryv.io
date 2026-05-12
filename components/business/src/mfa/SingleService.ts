/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const Service = require('./Service.ts').default;
const generateCode = require('./generateCode.ts').default;
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
  url: any;
  apiMethod: any;
  headers: any;
  body: any;
  codes: any;
  timeouts: any;
  ttlMilliseconds: any;
  constructor (mfaConfig: any) {
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

  async challenge (username: any, profile: any, _clientRequest: any) {
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

  async verify (username: any, _profile: any, clientRequest: any) {
    const code = this.codes.get(username);
    if (code !== clientRequest.body.code) {
      throw errors.invalidParametersFormat(
        `The provided MFA code is invalid: ${clientRequest.body.code}`,
        { id: 'invalid-mfa-code' }
      );
    }
    this.clearCode(username);
  }

  setCode (username: any, code: any) {
    this.codes.set(username, code);
    this.timeouts.set(
      username,
      setTimeout(() => this.clearCode(username), this.ttlMilliseconds)
    );
  }

  clearCode (username: any) {
    this.codes.delete(username);
    const t = this.timeouts.get(username);
    if (t) {
      clearTimeout(t);
      this.timeouts.delete(username);
    }
  }
}

SingleService.CODE = CODE;
export default SingleService;
export { SingleService };