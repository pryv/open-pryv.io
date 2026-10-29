/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/**
 * OAuth2 — operator-installed extension (`customExtensions:oauthExtension`).
 *
 * An extension supplies a whole-scope grammar for registry clients (clients
 * registered by the operator, with no app account behind them) and may add
 * fields to the token response, the id_token and the introspection answer.
 * The core keeps every OAuth / OIDC mechanic; the extension only maps its
 * scope vocabulary to Pryv permissions and adds domain claims.
 *
 * The module the operator points at exports a factory:
 *
 *   module.exports = function (host: { apiVersion, options, logger }) {
 *     return { apiVersion: 1, name, scopeGrammar: { parse, echo, supported? },
 *              tokenResponse?, idTokenClaims?, introspectionClaims?, claimsSupported? };
 *   };
 *
 * Versioning: an integer `apiVersion`. Adding an optional hook or an optional
 * context field does not bump it; changing a context field's meaning, a return
 * shape or a reserved-key list does. A mismatch fails the boot.
 *
 * `scopeGrammar.parse` must be pure and deterministic in (scope string,
 * client): the consent offer is not carried in the signed state but
 * re-derived at /accept and pinned by a digest.
 */

import { createRequire } from 'node:module';
import type { OAuthClient } from './storage.ts';
const require = createRequire(import.meta.url);

const { logServerError } = require('./serverLog.ts');

/** Contract versions this core supports. */
export const SUPPORTED_API_VERSIONS = [1];
/** The version the core announces to the factory. */
export const HOST_API_VERSION = 1;

/** A granular permission entry (accesses.create lexicon, consent annotations allowed). */
export type ExtPermission = Record<string, unknown>;

/** A client as the extension sees it: nothing secret crosses over. */
export type ClientView = Omit<OAuthClient, 'clientSecretHash' | 'jwks'>;

/** Consent offer synthesised by the grammar from a scope string. */
export type SynthOffer = {
  permissions: ExtPermission[];
  allowUserChoice?: boolean;
  /**
   * The app asked for a pseudonym: the grant gets a routable alias, which is
   * the subject the app sees. Absent / false: the subject is the user's stable
   * id. The core forces it on for a `pairwise` client.
   */
  randomAlias?: boolean;
  title?: Record<string, string>;
  description?: Record<string, string>;
  consent?: Record<string, string>;
  entryLabels?: Record<string, Record<string, string>>;
};

export type ParseResult =
  | { ok: true; tokens: string[]; offer: SynthOffer }
  | { ok: false; description: string };

/**
 * Context handed to the response hooks. `subject` is the grant's alias when the
 * grant is aliased (pseudonym asked, or a pairwise client), the user's stable
 * id otherwise (never the username). `scopeTokens` are the GRANTED tokens:
 * the core tokens granted plus the grammar's echo over the minted permissions
 * (never what was requested but not granted).
 */
export type HookCtx = {
  clientId: string;
  client: ClientView;
  subject: string | null;
  grantType: string;
  scopeTokens: string[];
  permissions: ExtPermission[];
  issuer: string;
};

export type OAuthExtension = {
  apiVersion: number;
  name: string;
  scopeGrammar: {
    parse (scopeString: string, ctx: { client: ClientView; purpose: 'request' | 'max' }): ParseResult;
    echo (ctx: { permissions: ExtPermission[]; requestedTokens: string[]; client: ClientView }): string[];
    supported? (): string[];
  };
  tokenResponse? (ctx: HookCtx): object | Promise<object>;
  idTokenClaims? (ctx: HookCtx): object | Promise<object>;
  introspectionClaims? (ctx: HookCtx): object | Promise<object>;
  claimsSupported?: string[];
};

export type HookName = 'tokenResponse' | 'idTokenClaims' | 'introspectionClaims';

/** Keys a hook may not set: the core owns them. */
export const RESERVED_KEYS: Record<HookName, string[]> = {
  tokenResponse: ['access_token', 'token_type', 'expires_in', 'refresh_token', 'scope', 'id_token', 'apiEndpoint'],
  idTokenClaims: ['iss', 'sub', 'aud', 'exp', 'iat', 'nonce', 'auth_time', 'azp'],
  introspectionClaims: ['active', 'scope', 'client_id', 'exp', 'iat', 'sub', 'iss', 'token_type', 'aud', 'cnf', 'api_base'],
};

const HOOK_NAMES: HookName[] = ['tokenResponse', 'idTokenClaims', 'introspectionClaims'];

let current: OAuthExtension | null = null;

/**
 * Validate an object returned by an extension factory. Throws with a message
 * naming the first contract violation.
 */
export function validateExtension (ext: unknown): OAuthExtension {
  if (ext == null || typeof ext !== 'object') throw new Error('oauth extension: factory must return an object');
  const e = ext as Record<string, unknown>;
  if (!Number.isInteger(e.apiVersion) || !SUPPORTED_API_VERSIONS.includes(e.apiVersion as number)) {
    throw new Error(`oauth extension: apiVersion ${String(e.apiVersion)} not supported by this core (supported: ${SUPPORTED_API_VERSIONS.join(', ')})`);
  }
  if (typeof e.name !== 'string' || e.name.length === 0) throw new Error('oauth extension: name must be a non-empty string');
  const g = e.scopeGrammar as Record<string, unknown> | null | undefined;
  if (g == null || typeof g !== 'object') throw new Error('oauth extension: scopeGrammar is required');
  if (typeof g.parse !== 'function') throw new Error('oauth extension: scopeGrammar.parse must be a function');
  if (typeof g.echo !== 'function') throw new Error('oauth extension: scopeGrammar.echo must be a function');
  if (g.supported != null && typeof g.supported !== 'function') throw new Error('oauth extension: scopeGrammar.supported must be a function');
  for (const h of HOOK_NAMES) {
    if (e[h] != null && typeof e[h] !== 'function') throw new Error(`oauth extension: ${h} must be a function`);
  }
  if (e.claimsSupported != null &&
      (!Array.isArray(e.claimsSupported) || e.claimsSupported.some((c) => typeof c !== 'string'))) {
    throw new Error('oauth extension: claimsSupported must be an array of strings');
  }
  return ext as OAuthExtension;
}

/**
 * Call an extension factory and validate what it returns. A throwing factory
 * or an invalid contract throws: the caller fails the boot.
 */
export function createExtension (
  factory: unknown,
  host: { options?: unknown; logger?: unknown }
): OAuthExtension {
  if (typeof factory !== 'function') throw new Error('oauth extension: module must export a factory function');
  let ext: unknown;
  try {
    ext = factory({ apiVersion: HOST_API_VERSION, options: host.options ?? {}, logger: host.logger });
  } catch (err: unknown) {
    throw new Error('oauth extension: factory failed: ' + ((err as Error)?.message ?? String(err)));
  }
  return validateExtension(ext);
}

/** Install (or clear, with null) the extension for this process. */
export function setExtension (ext: OAuthExtension | null): void {
  current = ext == null ? null : validateExtension(ext);
}

export function getExtension (): OAuthExtension | null {
  return current;
}

/** Test-only — clear the installed extension. */
export function _resetForTests (): void {
  current = null;
}

/** The client as handed to the extension: secrets removed. */
export function toClientView (client: OAuthClient): ClientView {
  const { clientSecretHash: _secret, jwks: _jwks, ...view } = client;
  return view;
}

/**
 * Run an optional response hook. Returns the extra fields (empty when the hook
 * is absent). Throws when the hook throws, returns a non-object, or sets a key
 * the core owns: the caller answers `server_error`.
 */
export async function runHook (name: HookName, ctx: HookCtx): Promise<Record<string, unknown>> {
  const ext = current;
  const hook = ext?.[name];
  if (typeof hook !== 'function') return {};
  let out: unknown;
  try {
    out = await hook.call(ext, ctx);
  } catch (err: unknown) {
    logServerError(`oauth extension ${ext!.name}: ${name} failed`, err);
    throw new Error(`oauth extension hook ${name} failed`);
  }
  if (out == null) return {};
  if (typeof out !== 'object' || Array.isArray(out)) {
    throw new Error(`oauth extension hook ${name} must return an object`);
  }
  const reserved = RESERVED_KEYS[name].filter((k) => Object.prototype.hasOwnProperty.call(out, k));
  if (reserved.length > 0) {
    const err = new Error(`oauth extension hook ${name} sets reserved key(s): ${reserved.join(', ')}`);
    logServerError(`oauth extension ${ext!.name}: reserved key collision`, err);
    throw err;
  }
  return out as Record<string, unknown>;
}
