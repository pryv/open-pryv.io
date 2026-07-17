/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/**
 * OAuth2 — pluggable scope-parser registry.
 *
 * The OAuth `scope` parameter is a space-separated list of tokens.
 * Each token has the shape `<namespace>:<token-body>` (e.g.
 * `cmc:study-A`). The namespace selects a parser registered in this
 * module.
 *
 * Ships with the `cmc` namespace registered (granular consent-offer
 * references — every authorization-code grant goes through an explicit
 * granular permission set; there are no coarse wildcard scopes). Other
 * grammars — SMART on FHIR `patient/Observation.read` for instance —
 * layer on by registering a parser; no migration of persisted scope
 * data is needed. See IMPLEMENTERS-GUIDE.md.
 */

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

const assert = require('node:assert/strict');

/**
 * A parsed scope token. Free-form per parser; the consuming code
 * (consent UI, access-row writer, etc.) knows the shape it expects.
 */
export type ParsedScope = {
  namespace: string;
  raw: string;
  permission: string; // 'granular' for cmc; other namespaces define their own
  // Parsers may add additional fields (e.g. resource type for SMART).
  [key: string]: unknown;
};

type ParserFn = (tokenBody: string) => ParsedScope;

const registry = new Map<string, ParserFn>();

/**
 * Register a parser for a namespace. Throws on duplicate registration —
 * register at boot only, before `registerRoutes()` is called.
 */
export function registerScopeParser (namespace: string, parser: ParserFn): void {
  assert(typeof namespace === 'string' && namespace.length > 0, 'namespace must be a non-empty string');
  assert(typeof parser === 'function', 'parser must be a function');
  if (registry.has(namespace)) {
    throw new Error(`scope parser for namespace "${namespace}" already registered`);
  }
  registry.set(namespace, parser);
}

/**
 * Parse the OAuth `scope` parameter string into an array of
 * `ParsedScope`s. Throws on malformed input (missing namespace,
 * unregistered namespace, parser failure).
 */
export function parseScopes (scopeString: string): ParsedScope[] {
  if (typeof scopeString !== 'string' || scopeString.length === 0) {
    return [];
  }
  const tokens = scopeString.split(/\s+/).filter((s) => s.length > 0);
  return tokens.map((token) => {
    const colonIdx = token.indexOf(':');
    if (colonIdx < 1) {
      throw new ScopeParseError(`scope token missing namespace prefix: "${token}"`);
    }
    const namespace = token.slice(0, colonIdx);
    const body = token.slice(colonIdx + 1);
    const parser = registry.get(namespace);
    if (parser == null) {
      throw new ScopeParseError(`unknown scope namespace "${namespace}" in token "${token}"`);
    }
    return parser(body);
  });
}

/**
 * Inspect the set of registered namespaces (test + diagnostics).
 */
export function listNamespaces (): string[] {
  return Array.from(registry.keys()).sort();
}

/**
 * Test-only — reset the registry. Production code never calls this.
 */
export function _resetForTests (): void {
  registry.clear();
  _registerDefault();
}

export class ScopeParseError extends Error {
  constructor (message: string) {
    super(message);
    this.name = 'ScopeParseError';
  }
}

// --- Default `cmc` parser ---

/**
 * `cmc:<offer-name>` — reference to a consent offer registered on the
 * OAuth client (`OAuthClient.cmcOffers[<offer-name>]`). The offer is a
 * cross-account-messaging-and-consent request published by the app's
 * account; it carries the granular `permissions[]` + consent texts the
 * consent UI displays and the grant mints. Resolution (name →
 * capability URL → offer content) happens at /oauth2/authorize time;
 * this parser only validates the token shape.
 */
const CMC_OFFER_NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/;

/**
 * Shared shape check for cmc offer names — used by this parser AND by
 * client-registration validation (`clientRegistry.persistClient`) so
 * the two can never drift.
 */
export function isValidCmcOfferName (name: unknown): boolean {
  return typeof name === 'string' && CMC_OFFER_NAME_RE.test(name);
}

function cmcParser (body: string): ParsedScope {
  if (!CMC_OFFER_NAME_RE.test(body)) {
    throw new ScopeParseError(
      `invalid cmc offer name "${body}" — expected 1-64 chars of [a-zA-Z0-9._-], starting alphanumeric`,
    );
  }
  return {
    namespace: 'cmc',
    raw: `cmc:${body}`,
    permission: 'granular',
    offerName: body,
  };
}

function _registerDefault (): void {
  registry.set('cmc', cmcParser);
}

_registerDefault();
