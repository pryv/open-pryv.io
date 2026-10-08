/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { timingSafeEqual } = require('node:crypto');
const Service = require('./Service.ts').default;
const generateCode = require('./generateCode.ts').default;
const { isValidCode, invalidCodeError, toValues, renderRequest } = require('./smsRequest.ts');

const CODE_LENGTH = 4;
const CODE = 'code';

/**
 * Single-endpoint SMS MFA: service-core generates the code itself, sends it
 * via one HTTP call (the SMS provider just delivers it), and validates the
 * verify request locally against the expected code.
 *
 * The expected code is kept in `cluster_kv` (master-held, shared by the API
 * workers, like the MFA sessions), keyed by username and TTL-bound (matching
 * the session TTL), so a verify handled by another worker sees it.
 */
type MFAConfig = {
  sms: { endpoints: { single: { url: string; method: string; headers: Record<string, unknown>; body: unknown } } };
  sessions?: { ttlSeconds?: number };
  [k: string]: unknown;
};
type Profile = { content: Record<string, unknown>; [k: string]: unknown };
type ClientRequest = { body: { code?: unknown; [k: string]: unknown }; headers?: Record<string, unknown> };
interface CodeStore {
  get: (key: string) => Promise<unknown>;
  set: (key: string, value: unknown, opts?: { ttlMs?: number }) => Promise<boolean>;
  delete: (key: string) => Promise<void>;
}

class SingleService extends Service {
  url: string;
  apiMethod: string;
  headers: Record<string, unknown>;
  body: unknown;
  kv: CodeStore;
  namespace: string;
  ttlMilliseconds: number;
  constructor (mfaConfig: MFAConfig, opts: { kvClient?: CodeStore } = {}) {
    super(mfaConfig);
    const single = mfaConfig.sms.endpoints.single;
    this.url = single.url;
    this.apiMethod = single.method;
    this.headers = single.headers;
    this.body = single.body;
    this.kv = opts.kvClient || require('messages/src/cluster_kv.ts').clientFor();
    this.namespace = 'mfa-sms-code/';
    this.ttlMilliseconds = (mfaConfig.sessions?.ttlSeconds ?? 1800) * 1000;
  }

  async challenge (username: string, profile: Profile, _clientRequest: ClientRequest) {
    const code = await generateCode(CODE_LENGTH);
    await this.setCode(username, code);
    // Make the code available alongside profile.content for templating.
    const values = { ...toValues(profile.content), [CODE]: code };
    const { url, headers, body } = renderRequest({ url: this.url, headers: this.headers, body: this.body }, values);
    await this._makeRequest(this.apiMethod, url, headers, body);
  }

  async verify (username: string, _profile: Profile, clientRequest: ClientRequest) {
    // Fails closed: no code sent, or none pending for this user, is a refusal.
    const supplied = clientRequest.body.code;
    if (!isValidCode(supplied)) throw invalidCodeError();
    const expected = await this.kv.get(this.namespace + username);
    if (!sameCode(expected, supplied)) throw invalidCodeError();
    await this.clearCode(username);
  }

  async setCode (username: string, code: string) {
    await this.kv.set(this.namespace + username, code, { ttlMs: this.ttlMilliseconds });
  }

  async clearCode (username: string) {
    await this.kv.delete(this.namespace + username);
  }
}

function sameCode (expected: unknown, supplied: unknown): boolean {
  if (typeof expected !== 'string' || expected === '') return false;
  if (typeof supplied !== 'string') return false;
  const a = Buffer.from(supplied);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

SingleService.CODE = CODE;
export default SingleService;
export { SingleService };