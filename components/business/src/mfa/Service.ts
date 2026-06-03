/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
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
type Logger = { error (msg: string, ctx?: Record<string, unknown>): void; info?: (m: string) => void; warn?: (m: string) => void };
type MFAConfig = Record<string, unknown>;
type Profile = { content: Record<string, unknown>; [k: string]: unknown };
type ClientRequest = { headers: Record<string, unknown>; body: Record<string, unknown> };
type Headers = Record<string, unknown>;
type FetchInit = { method: string; headers: Headers; body?: string | Record<string, unknown> };

class Service {
  config: MFAConfig;
  logger: Logger;

  static replaceAll: (text: string, key: string, value: unknown) => string;
  static replaceRecursively: (obj: unknown, key: string, value: unknown) => unknown;

  /**
   * @param mfaConfig - the `services.mfa` config block
   */
  constructor (mfaConfig: MFAConfig) {
    this.config = mfaConfig;
    this.logger = getLogger('mfa-service');
  }

  /**
   * @param clientRequest - { headers, body, ... } — the MFA HTTP request context
   */
  async challenge (_username: string, _profile: Profile, _clientRequest: ClientRequest) {
    throw new Error('override challenge() in a Service subclass');
  }

  async verify (_username: string, _profile: Profile, _clientRequest: ClientRequest) {
    throw new Error('override verify() in a Service subclass');
  }

  /**
   * Make a POST or GET request to an SMS provider endpoint.
   */
  async _makeRequest (method: string, url: string, headers: Headers, body: unknown) {
    try {
      const init: FetchInit = { method, headers: { ...headers } };
      if (method === 'POST') {
        if (body != null && typeof body !== 'string') {
          init.body = JSON.stringify(body);
          if (init.headers['Content-Type'] == null) {
            init.headers['Content-Type'] = 'application/json';
          }
        } else {
          init.body = body as string;
        }
      }
      const res = await fetch(url, init as RequestInit);
      if (!res.ok) {
        const errBody = await res.text().catch(() => '');
        throw new Error(`HTTP ${res.status} ${res.statusText}${errBody ? ` — ${errBody}` : ''}`);
      }
      return res;
    } catch (error: unknown) {
      const e = error as Error;
      this.logger.error(
        `MFA SMS provider request failed: ${method} ${url}`,
        { error: e.message }
      );
      throw errors.invalidOperation(
        `MFA SMS provider error: ${e.message}`,
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
  return text.split(`{{ ${key} }}`).join(String(value));
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
    const out: Record<string, unknown> = {};
    const rec = obj as Record<string, unknown>;
    for (const k of Object.keys(rec)) {
      out[k] = Service.replaceRecursively(rec[k], key, value);
    }
    return out;
  }
  return obj;
};

export default Service;
export { Service };