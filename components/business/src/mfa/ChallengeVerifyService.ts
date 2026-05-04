/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
import type {} from 'node:fs';


const Service = require('./Service');

/**
 * Two-step SMS MFA: separate `challenge` and `verify` HTTP endpoints on the
 * external SMS provider. The provider generates and validates the code itself
 * — service-core never sees it.
 */
class ChallengeVerifyService extends Service {
  constructor (mfaConfig) {
    super(mfaConfig);
    const eps = mfaConfig.sms.endpoints;
    this.challengeUrl = eps.challenge.url;
    this.challengeMethod = eps.challenge.method;
    this.challengeHeaders = eps.challenge.headers;
    this.challengeBody = eps.challenge.body;
    this.verifyUrl = eps.verify.url;
    this.verifyMethod = eps.verify.method;
    this.verifyHeaders = eps.verify.headers;
    this.verifyBody = eps.verify.body;
  }

  async challenge (_username, profile, _clientRequest) {
    const replacements = profile.content;
    let url = this.challengeUrl;
    let headers = this.challengeHeaders;
    let body = this.challengeBody;
    for (const [key, value] of Object.entries(replacements)) {
      headers = Service.replaceRecursively(headers, key, value);
      body = Service.replaceAll(body, key, value);
      url = Service.replaceAll(url, key, value);
    }
    await this._makeRequest(this.challengeMethod, url, headers, body);
  }

  async verify (_username, profile, clientRequest) {
    // Verify-time replacements include both the persisted profile content and
    // whatever the client sent in the verify request body (typically `code`).
    const replacements = Object.assign({}, clientRequest.body, profile.content);
    let url = this.verifyUrl;
    let headers = this.verifyHeaders;
    let body = this.verifyBody;
    for (const [key, value] of Object.entries(replacements)) {
      headers = Service.replaceRecursively(headers, key, value);
      body = Service.replaceAll(body, key, value);
      url = Service.replaceAll(url, key, value);
    }
    await this._makeRequest(this.verifyMethod, url, headers, body);
  }
}

module.exports = ChallengeVerifyService;
