/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const Service = require('./Service.ts').default;
const { isValidCode, invalidCodeError, toValues, renderRequest, verifyAnswerAccepted } = require('./smsRequest.ts');

/**
 * Two-step SMS MFA: separate `challenge` and `verify` HTTP endpoints on the
 * external SMS provider. The provider generates and validates the code itself
 * — service-core never sees it.
 *
 * A verify succeeds only when the provider answers 2xx AND its answer passes
 * the verify endpoint's `success` predicate (see `verifyAnswerAccepted`):
 * without a predicate, only an empty answer is a success.
 */
type MfaSmsEndpoint = { url: string; method: string; headers: Record<string, unknown>; body: Record<string, unknown> | string; success?: unknown };
type MfaConfig = { sms: { endpoints: { challenge: MfaSmsEndpoint; verify: MfaSmsEndpoint }; [k: string]: unknown }; [k: string]: unknown };
type ProfileLike = { content: Record<string, unknown> };
type ClientRequestLike = { body?: Record<string, unknown>; [k: string]: unknown };

class ChallengeVerifyService extends Service {
  challengeEndpoint: MfaSmsEndpoint;
  verifyEndpoint: MfaSmsEndpoint;
  warnedUninterpretedAnswer: boolean;
  constructor (mfaConfig: MfaConfig) {
    super(mfaConfig);
    const eps = mfaConfig.sms.endpoints;
    this.challengeEndpoint = eps.challenge;
    this.verifyEndpoint = eps.verify;
    this.warnedUninterpretedAnswer = false;
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
    const res = await this._makeRequest(this.verifyEndpoint.method, url, headers, body);
    const answer: string | null = await res.text().catch(() => null);
    const predicate = this.verifyEndpoint.success;
    if (answer == null || !verifyAnswerAccepted(answer, predicate)) {
      if (predicate == null && answer != null && !this.warnedUninterpretedAnswer) {
        // A configuration matter, not a guess: logged once per process.
        this.warnedUninterpretedAnswer = true;
        this.logger.warn('MFA SMS provider answered a verify with a body, and the verify endpoint has no success predicate (endpoints.verify.success): the code is refused. Configure the predicate for this provider.');
      }
      throw invalidCodeError();
    }
  }
}

export default ChallengeVerifyService;
export { ChallengeVerifyService };
