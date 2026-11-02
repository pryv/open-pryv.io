/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/**
 * OAuth2: operator-installed extension (`customExtensions:oauthExtension`).
 *
 * An extension supplies a whole-scope grammar for registry clients (clients
 * registered by the operator, with no app account behind them) and may add
 * fields to the token response. The core keeps every OAuth mechanic; the
 * extension only maps its scope vocabulary to Pryv permissions and adds
 * domain fields.
 *
 * The module the operator points at exports a factory:
 *
 *   module.exports = function (host: { apiVersion, options, logger }) {
 *     return { apiVersion: 1, name, scopeGrammar: { parse, echo, supported?, grantState? },
 *              tokenResponse?, idTokenClaims?, introspectionClaims?, claimsSupported? };
 *   };
 *
 * `idTokenClaims` adds claims to the OpenID Connect id_token (code exchange
 * with `openid` granted; it may not set a claim the core owns) and
 * `claimsSupported` lists them in the OpenID Connect discovery document.
 * `introspectionClaims` adds members to the introspection answer of a
 * registry client's session (it may not set a member the core answers).
 *
 * `scopeGrammar.grantState` (optional) computes the grant's state: one
 * JSON-serialisable value per grant (or `undefined` for none), computed at
 * every consent (the first and each re-authorization) once the grant's
 * permissions are final, and REPLACING the previous one; never recomputed at
 * a refresh nor when the account owner narrows the grant. At most
 * `GRANT_STATE_MAX_BYTES` (16 KiB) of JSON. Over the bound, unserialisable,
 * throwing or not settling in time: an extension error, the consent answers
 * `server_error` and the grant is left as it was. The core stores it on the
 * grant (written by the server only) and hands it back as `grantState` to
 * `echo` and to every response hook. It is advisory: `permissions` in each
 * context is the live truth (the owner may have narrowed the grant since),
 * so an echo or a claim derived from the state must be intersected with
 * `permissions`; the echo is checked against `permissions` only.
 *
 * Versioning: an integer `apiVersion`. Adding an optional hook or an optional
 * context field does not bump it; changing a context field's meaning, a return
 * shape or a reserved-key list does. A mismatch fails the boot.
 *
 * Grammar rules the core enforces (a violation is a contract error: the
 * request answers `invalid_scope` and the server logs it):
 *   - `parse` must be pure and deterministic in (scope string, client): the
 *     consent offer is not carried in the signed state but re-derived at
 *     /accept and pinned by a digest.
 *   - at most one permission entry per stream (after canonicalisation:
 *     `a` and `:local:a` are the same stream);
 *   - no `defaultName` / `name` on a permission (consent must never create
 *     a stream; they are removed and logged);
 *   - `echo` answers the scope string that, parsed by this grammar as a
 *     request, names what the minted permissions hold: it may name tokens
 *     the client did not request (a narrowed token, a per-stream token, a
 *     marker that expands to no permission), it may never claim a stream or
 *     a level the permissions do not hold (an extension error,
 *     `server_error`), and it should not leave held reach unnamed (logged).
 *     The core parses the echoed string whole, with `purpose: 'request'`, so
 *     the request rules above apply to it; a stream entry is held only by an
 *     entry on the same stream (no inheritance through the stream tree, a
 *     stream held at `none` is not held), a feature entry by the same entry
 *     (a `forbidden` one always passes). At most 1000 tokens, never a core
 *     token (`openid`, `offline_access`: the core adds them). Its context
 *     tells whether the subject is an alias (`aliased`).
 *
 * Entry keys name an entry of the consent screen: `s|<streamId>|<level>` for
 * a stream entry and `f|<feature>|<setting>` for a feature entry, or the
 * level-less `s|<streamId>` and `f|<feature>`, which name the entry whatever
 * level or setting the screen shows it at (a held entry the composition
 * joins to another level, or one outside the request). The consent UI looks
 * up the exact key first, then the level-less one. The stream id is matched
 * literally: use the spelling the grammar puts in its permissions.
 *
 * `entryLabels` (optional, display only, passed through to the consent UI
 * unchanged): keyed by entry keys, each value a localised text
 * `{ [languageCode]: string }`.
 *
 * `entryGroups` (optional, display only; absent, not `null`): an ordered
 * array of `{ key, label, entries }`, the order being the display order;
 * `key` an opaque string of 1 to 64 characters, unique in the offer; `label`
 * a localised text (at most 16 languages, each at most 200 characters);
 * `entries` entry keys (each at most 300 characters). At most 64 groups and
 * 1000 entry keys across them; an entry key in two groups (or twice in one)
 * is a contract error. Keys may name entries that are not in the offer (a
 * group lists its whole membership, so a held entry outside the request
 * falls into it on a re-consent); an entry of the offer no group names is
 * shown ungrouped. Other members of a group are dropped. Grouping is part
 * of the digests; it never removes an entry from the screen, and the
 * consent answer (`grantedPermissions`) stays a flat list.
 *
 * The whole offer (permissions, texts, labels, groups) is bounded to
 * `MAX_SYNTH_OFFER_BYTES` (256 KiB) of canonical JSON; over it, or not JSON,
 * a contract error. Character limits count UTF-16 code units.
 *
 * These checks run on EVERY parse: the request, the registered scope
 * (`purpose: 'max'`: a failure refuses every request of the client, and the
 * boot check warns) and the echo (a failure comes after the consent: the
 * code exchange, a refresh or an introspection answers `server_error`). The
 * `max` offer is never shown and is the largest: emit no display members
 * (labels, groups, texts) for `purpose: 'max'`.
 *
 * Hooks that may be asynchronous are bounded by
 * `oauth:extensionHookTimeoutMs` (default 5000): a hook that does not settle
 * in time is a hook failure.
 */

import type { OAuthClient } from './storage.ts';
import { logServerError } from './serverLog.ts';

/** Contract versions this core supports. */
export const SUPPORTED_API_VERSIONS = [1];
/** The version the core announces to the factory. */
export const HOST_API_VERSION = 1;

/** A granular permission entry (accesses.create lexicon, consent annotations allowed). */
export type ExtPermission = Record<string, unknown>;

/** A client as the extension sees it: nothing secret crosses over, nor the operator trail. */
export type ClientView = Omit<OAuthClient, 'clientSecretHash' | 'previousSecretHash' | 'jwks' | 'statusLog'>;

/** Consent offer synthesised by the grammar from a scope string. */
export type SynthOffer = {
  permissions: ExtPermission[];
  allowUserChoice?: boolean;
  /**
   * The app asks for a pseudonym: the grant gets a routable alias (`r-` + 8
   * characters, one per user and client), which is the subject the app sees;
   * every session of the grant carries that alias and is used at it only
   * (`https://<alias>.<domain>/`), and the account's username reaches the app
   * in no answer. Always set by the core for a `pairwise` client. Absent /
   * false: the subject is the user's stable internal id.
   */
  randomAlias?: boolean;
  title?: Record<string, string>;
  description?: Record<string, string>;
  consent?: Record<string, string>;
  /** Display labels per entry, see the key format above. */
  entryLabels?: Record<string, Record<string, string>>;
  /** Display groups of entries, in display order, see above. */
  entryGroups?: EntryGroup[];
};

/** A display group of consent entries (see `entryGroups` above). */
export type EntryGroup = {
  key: string;
  label: Record<string, string>;
  /** Entry keys, see the key format above. */
  entries: string[];
};

export type ParseResult =
  | { ok: true; tokens: string[]; offer: SynthOffer }
  | { ok: false; description: string };

/**
 * Context handed to the response hooks. `subject` is the user's stable
 * internal id (never the username; not routable: it does not address the
 * account), or, for a pseudonymous grant (`aliased: true`), the grant's alias
 * (routable: the session is used at it). `scopeTokens` are the GRANTED tokens:
 * the core tokens granted plus the grammar's echo over the minted permissions
 * (never what was requested but not granted).
 */
export type HookCtx = {
  clientId: string;
  client: ClientView;
  subject: string | null;
  /** Whether `subject` is the grant's alias (optional context field). */
  aliased?: boolean;
  /**
   * The grant's state, as `scopeGrammar.grantState` computed it at the last
   * consent (optional context field; `undefined` when there is none).
   * Advisory: `permissions` is authoritative.
   */
  grantState?: unknown;
  grantType: string;
  scopeTokens: string[];
  permissions: ExtPermission[];
  issuer: string;
  /**
   * The resource server the authorization named (`aud`, or its RFC 8707
   * spelling `resource`); absent when none (optional context field).
   */
  audience?: string;
};

export type OAuthExtension = {
  apiVersion: number;
  name: string;
  scopeGrammar: {
    parse (scopeString: string, ctx: { client: ClientView; purpose: 'request' | 'max' }): ParseResult;
    /**
     * The scope tokens naming what `permissions` (the minted session's)
     * hold, `requestedTokens` being the grammar tokens of the request. Parsed
     * again by `parse` as a request and checked against `permissions`: may
     * name unrequested tokens, may never claim reach not held (see the
     * contract rules above). `aliased` (optional context field): the
     * subject is the grant's alias, so the echo may name the grammar's
     * pseudonym marker, e.g. for a `pairwise` client that did not ask for one.
     */
    echo (ctx: { permissions: ExtPermission[]; requestedTokens: string[]; client: ClientView; aliased?: boolean; grantState?: unknown }): string[];
    supported? (): string[];
    /**
     * The grant's state after a consent: `permissions` are the grant's final
     * permissions, `requestedTokens` the grammar tokens of the request. See
     * the contract above (bound, replacement, advisory).
     */
    grantState? (ctx: { permissions: ExtPermission[]; requestedTokens: string[]; client: ClientView }): unknown;
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
  introspectionClaims: ['active', 'scope', 'client_id', 'exp', 'iat', 'sub', 'iss', 'token_type', 'aud', 'cnf', 'api_base', 'permissions'],
};

const HOOK_NAMES: HookName[] = ['tokenResponse', 'idTokenClaims', 'introspectionClaims'];

/** Default bound on an asynchronous hook, in milliseconds. */
export const DEFAULT_HOOK_TIMEOUT_MS = 5000;

let current: OAuthExtension | null = null;
let hookTimeoutMs = DEFAULT_HOOK_TIMEOUT_MS;
// Bumped at every install: memoised grammar answers key on it.
let generation = 0;

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
  if (g.grantState != null && typeof g.grantState !== 'function') throw new Error('oauth extension: scopeGrammar.grantState must be a function');
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

/**
 * Install (or clear, with null) the extension for this process.
 * `opts.hookTimeoutMs`: bound on each asynchronous hook (positive number;
 * anything else keeps the default).
 */
export function setExtension (ext: OAuthExtension | null, opts: { hookTimeoutMs?: number } = {}): void {
  current = ext == null ? null : validateExtension(ext);
  generation++;
  const t = Number(opts.hookTimeoutMs);
  hookTimeoutMs = Number.isFinite(t) && t > 0 ? t : DEFAULT_HOOK_TIMEOUT_MS;
}

export function getExtension (): OAuthExtension | null {
  return current;
}

/** Changes whenever an extension is installed or cleared. */
export function extensionGeneration (): number {
  return generation;
}

/** Test-only: clear the installed extension and the hook bound. */
export function _resetForTests (): void {
  current = null;
  generation++;
  hookTimeoutMs = DEFAULT_HOOK_TIMEOUT_MS;
}

/**
 * Await a hook's answer, bounded by the configured timeout. A timeout
 * rejects like a throwing hook; the hook's own late settlement is ignored.
 */
async function withHookTimeout (name: string, value: unknown): Promise<unknown> {
  if (value == null || typeof (value as { then?: unknown }).then !== 'function') return value;
  const pending = Promise.resolve(value);
  // A hook that settles after the timeout must not surface as an
  // unhandled rejection.
  pending.catch(() => {});
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`oauth extension hook ${name} timed out after ${hookTimeoutMs} ms`)), hookTimeoutMs);
  });
  try {
    return await Promise.race([pending, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/** The client as handed to the extension: secrets removed. */
export function toClientView (client: OAuthClient): ClientView {
  const { clientSecretHash: _secret, previousSecretHash: _previous, jwks: _jwks, statusLog: _log, ...view } = client;
  return view;
}

/**
 * Run an optional response hook. Returns the extra fields (empty when the hook
 * is absent). Throws when the hook throws, does not settle within the hook
 * timeout, returns a non-object, or sets a key the core owns: the caller
 * answers `server_error`.
 */
export async function runHook (name: HookName, ctx: HookCtx): Promise<Record<string, unknown>> {
  const ext = current;
  const hook = ext?.[name];
  if (typeof hook !== 'function') return {};
  let out: unknown;
  try {
    out = await withHookTimeout(name, (hook as (c: HookCtx) => unknown).call(ext, ctx));
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

/** Bound on a grant's state, in bytes of its JSON form. */
export const GRANT_STATE_MAX_BYTES = 16 * 1024;

/**
 * The grant's state after a consent, from `scopeGrammar.grantState`:
 * `{ name, value }`, `name` being the extension's (the key the state is
 * stored under) and `value` the state as its JSON round trip gives it
 * (`undefined`: no state). Without an extension or without the hook, no
 * state. Throws (an extension error, the caller answers `server_error`) when
 * the hook throws, does not settle within the hook timeout, or answers a
 * value that is not JSON-serialisable or whose JSON exceeds
 * `GRANT_STATE_MAX_BYTES`; the size is logged.
 */
export async function computeGrantState (ctx: {
  permissions: ExtPermission[]; requestedTokens: string[]; client: ClientView;
}): Promise<{ name: string | null; value: unknown }> {
  const ext = current;
  const hook = ext?.scopeGrammar.grantState;
  if (ext == null) return { name: null, value: undefined };
  if (typeof hook !== 'function') return { name: ext.name, value: undefined };
  let out: unknown;
  try {
    out = await withHookTimeout('grantState', hook.call(ext.scopeGrammar, ctx));
  } catch (err: unknown) {
    logServerError(`oauth extension ${ext.name}: grantState failed`, err);
    throw new Error('oauth extension hook grantState failed');
  }
  if (out === undefined) return { name: ext.name, value: undefined };
  let json: string | undefined;
  try {
    json = JSON.stringify(out);
  } catch (err: unknown) {
    const e = new Error(`oauth extension hook grantState answered a value that is not JSON-serialisable: ${(err as Error)?.message ?? String(err)}`);
    logServerError(`oauth extension ${ext.name}: grantState refused`, e);
    throw e;
  }
  if (typeof json !== 'string') {
    const e = new Error(`oauth extension hook grantState answered a value that is not JSON-serialisable (${typeof out})`);
    logServerError(`oauth extension ${ext.name}: grantState refused`, e);
    throw e;
  }
  const size = Buffer.byteLength(json);
  if (size > GRANT_STATE_MAX_BYTES) {
    const e = new Error(`oauth extension hook grantState answered ${size} bytes of JSON, over the bound of ${GRANT_STATE_MAX_BYTES}`);
    logServerError(`oauth extension ${ext.name}: grantState refused`, e);
    throw e;
  }
  return { name: ext.name, value: frozenGrantState(JSON.parse(json)) };
}

/**
 * A grant state as the hooks get it: deeply frozen, so the echo and the
 * hooks of one request all see the state as stored (one hook cannot change
 * what the next one reads).
 */
export function frozenGrantState<T> (value: T): T {
  if (value != null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const v of Object.values(value as Record<string, unknown>)) frozenGrantState(v);
    Object.freeze(value);
  }
  return value;
}
