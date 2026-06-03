/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const Service = require('./Service.ts').default;

/**
 * Two-step SMS MFA: separate `challenge` and `verify` HTTP endpoints on the
 * external SMS provider. The provider generates and validates the code itself
 * — service-core never sees it.
 */
type MfaSmsEndpoint = { url: string; method: string; headers: Record<string, unknown>; body: Record<string, unknown> | string };
type MfaConfig = { sms: { endpoints: { challenge: MfaSmsEndpoint; verify: MfaSmsEndpoint }; [k: string]: unknown }; [k: string]: unknown };
type ProfileLike = { content: Record<string, unknown> };
type ClientRequestLike = { body?: Record<string, unknown>; [k: string]: unknown };

class ChallengeVerifyService extends Service {
  constructor (mfaConfig: MfaConfig) {
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

  async challenge (_username: string, profile: ProfileLike, _clientRequest: ClientRequestLike) {
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

  async verify (_username: string, profile: ProfileLike, clientRequest: ClientRequestLike) {
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

export default ChallengeVerifyService;
export { ChallengeVerifyService };