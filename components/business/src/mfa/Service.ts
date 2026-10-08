/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
import { createRequire } from 'node:module';
import type { Logger } from '@pryv/boiler';
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
type MFAConfig = Record<string, unknown>;
type Profile = { content: Record<string, unknown>; [k: string]: unknown };
type ClientRequest = { headers: Record<string, unknown>; body: Record<string, unknown>; sessionId?: string };
type Headers = Record<string, unknown>;
type FetchInit = { method: string; headers: Headers; body?: string | Record<string, unknown> };

class Service {
  config: MFAConfig;
  logger: Logger;

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
   * Make a POST or GET request to an SMS provider endpoint. Answers the
   * response when it is 2xx.
   *
   * What a failure reveals is kept to the provider host and the HTTP status:
   * the rendered URL can carry the phone number and, for a verify, the code,
   * and the provider's answer is the provider's, so neither the path, the
   * query, nor the response body is logged or returned to the API client.
   */
  async _makeRequest (method: string, url: string, headers: Headers, body: unknown): Promise<Response> {
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
    const host = providerHost(url);
    let res: Response;
    try {
      res = await fetch(url, init as RequestInit);
    } catch (error: unknown) {
      this.logger.error(`MFA SMS provider request failed: ${method} ${host}: ${errorCode(error)}`);
      throw errors.invalidOperation('The SMS provider could not be reached.', { id: 'mfa-sms-provider-error' });
    }
    if (!res.ok) {
      // Drain the answer without reading it into a message.
      await res.arrayBuffer().catch(() => null);
      this.logger.error(`MFA SMS provider refused the request: ${method} ${host} answered HTTP ${res.status}`);
      throw errors.invalidOperation(`The SMS provider refused the request (HTTP ${res.status}).`, { id: 'mfa-sms-provider-error' });
    }
    return res;
  }
}

/** The host (and port) of a provider URL: never its path, query or credentials. */
function providerHost (url: string): string {
  try {
    return new URL(url).host || '(no host)';
  } catch {
    return '(invalid URL)';
  }
}

/** A short code for a transport error; its message may quote the URL. */
function errorCode (error: unknown): string {
  const e = error as { name?: unknown; code?: unknown; cause?: { code?: unknown } } | null;
  const code = e?.cause?.code ?? e?.code ?? e?.name;
  return typeof code === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(code) ? code : 'error';
}

export default Service;
export { Service };