/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
import { createRequire } from 'node:module';
import type { SmsCode } from './SessionStore.ts';
const require = createRequire(import.meta.url);
const { createHash, timingSafeEqual } = require('node:crypto');
const errors = require('errors').factory;
const Service = require('./Service.ts').default;
const SessionStore = require('./SessionStore.ts').default;
const generateCode = require('./generateCode.ts').default;
const { isValidCode, invalidCodeError, toValues, renderRequest } = require('./smsRequest.ts');

const DEFAULT_CODE_LENGTH = 6;
const DEFAULT_CODE_TTL_SECONDS = 300;
const CODE = 'code';

/**
 * Single-endpoint SMS MFA: service-core generates the code itself, sends it
 * via one HTTP call (the SMS provider just delivers it), and validates the
 * verify request locally against the expected code.
 *
 * The expected code belongs to ONE pending MFA session: its hash is kept in
 * that session's record (cluster_kv, shared by the API workers), with its own
 * expiry, shorter than the session's. So two sessions never share a code, a
 * code is refused once it has expired even while its session lives, and a new
 * challenge on the session replaces the code (and restarts its lifetime). The
 * challenge and verify requests name the session (`sessionId`, the mfaToken).
 */
type MFAConfig = {
  sms: { endpoints: { single: { url: string; method: string; headers: Record<string, unknown>; body: unknown } } };
  sessions?: { ttlSeconds?: number };
  [k: string]: unknown;
};
type Profile = { content: Record<string, unknown>; [k: string]: unknown };
type ClientRequest = { body: { code?: unknown; [k: string]: unknown }; headers?: Record<string, unknown>; sessionId?: unknown };
interface CodeSessions {
  get: (id: string) => Promise<{ smsCode?: SmsCode | null } | undefined>;
  setSmsCode: (id: string, smsCode: SmsCode | null) => Promise<boolean>;
}
type Opts = { sessionStore?: CodeSessions; codeLength?: number; codeTtlSeconds?: number };

class SingleService extends Service {
  static CODE = CODE;
  url: string;
  apiMethod: string;
  headers: Record<string, unknown>;
  body: unknown;
  sessions: CodeSessions;
  codeLength: number;
  codeTtlMilliseconds: number;
  constructor (mfaConfig: MFAConfig, opts: Opts = {}) {
    super(mfaConfig);
    const single = mfaConfig.sms.endpoints.single;
    this.url = single.url;
    this.apiMethod = single.method;
    this.headers = single.headers;
    this.body = single.body;
    this.sessions = opts.sessionStore || new SessionStore(mfaConfig.sessions?.ttlSeconds ?? 1800);
    this.codeLength = opts.codeLength ?? DEFAULT_CODE_LENGTH;
    this.codeTtlMilliseconds = (opts.codeTtlSeconds ?? DEFAULT_CODE_TTL_SECONDS) * 1000;
  }

  async challenge (_username: string, profile: Profile, clientRequest: ClientRequest) {
    const sessionId = clientRequest?.sessionId;
    if (typeof sessionId !== 'string' || sessionId === '') {
      throw errors.unexpectedError(new Error('SMS MFA challenge without an MFA session'));
    }
    const code = await generateCode(this.codeLength);
    // Stored before it is sent, so a verify that comes back fast finds it.
    const stored = await this.sessions.setSmsCode(sessionId, {
      hash: codeHash(sessionId, code),
      expiresAt: Date.now() + this.codeTtlMilliseconds
    });
    if (!stored) throw errors.invalidAccessToken('Invalid or expired MFA session token.');
    // Make the code available alongside profile.content for templating.
    const values = { ...toValues(profile.content), [CODE]: code };
    const { url, headers, body } = renderRequest({ url: this.url, headers: this.headers, body: this.body }, values);
    await this._makeRequest(this.apiMethod, url, headers, body);
  }

  async verify (_username: string, _profile: Profile, clientRequest: ClientRequest) {
    // Fails closed: no code sent, no session named, none pending on it, or
    // one that has expired, is a refusal.
    const supplied = clientRequest.body.code;
    if (!isValidCode(supplied)) throw invalidCodeError();
    const sessionId = clientRequest.sessionId;
    if (typeof sessionId !== 'string' || sessionId === '') throw invalidCodeError();
    const pending = (await this.sessions.get(sessionId))?.smsCode;
    if (pending == null || typeof pending.hash !== 'string' || !(pending.expiresAt > Date.now())) throw invalidCodeError();
    if (!sameHash(pending.hash, codeHash(sessionId, supplied as string))) throw invalidCodeError();
    // Single use.
    await this.sessions.setSmsCode(sessionId, null);
  }
}

/** Bound to its session, so equal codes of two sessions hash differently. */
function codeHash (sessionId: string, code: string): string {
  return createHash('sha256').update(sessionId + ':' + code).digest('hex');
}

function sameHash (expected: string, supplied: string): boolean {
  const a = Buffer.from(supplied);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export default SingleService;
export { SingleService, DEFAULT_CODE_LENGTH, DEFAULT_CODE_TTL_SECONDS };
