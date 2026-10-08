/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const Service = require('./Service.ts').default;
const { isValidCode, invalidCodeError, toValues, renderRequest } = require('./smsRequest.ts');

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
  challengeEndpoint: MfaSmsEndpoint;
  verifyEndpoint: MfaSmsEndpoint;
  constructor (mfaConfig: MfaConfig) {
    super(mfaConfig);
    const eps = mfaConfig.sms.endpoints;
    this.challengeEndpoint = eps.challenge;
    this.verifyEndpoint = eps.verify;
  }

  async challenge (_username: string, profile: ProfileLike, _clientRequest: ClientRequestLike) {
    const { url, headers, body } = renderRequest(this.challengeEndpoint, toValues(profile.content));
    await this._makeRequest(this.challengeEndpoint.method, url, headers, body);
  }

  async verify (_username: string, profile: ProfileLike, clientRequest: ClientRequestLike) {
    // Only the code is taken from the client request; the rest of the values
    // are the stored enrolment content.
    const code = (clientRequest.body || {}).code;
    if (!isValidCode(code)) throw invalidCodeError();
    const values = { ...toValues(profile.content), code };
    const { url, headers, body } = renderRequest(this.verifyEndpoint, values);
    await this._makeRequest(this.verifyEndpoint.method, url, headers, body);
  }
}

export default ChallengeVerifyService;
export { ChallengeVerifyService };
