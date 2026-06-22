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
 * `pryv:read`, `pryv:write`, `pryv:manage`). The namespace selects a
 * parser registered in this module.
 *
 * Ships with the `pryv` namespace registered (the three coarse
 * named-scopes from Phase A §17 Q3 close). The SMART on FHIR
 * follow-up plan will register a `smart` parser without rewriting
 * any of this — see IMPLEMENTERS-GUIDE.md.
 *
 * Why pluggable from day one: Leaves room for
 * SMART scope grammar (`patient/Observation.read`, etc.) without a
 * persisted-scope-data migration. design decision.
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
  permission: 'read' | 'write' | 'manage' | string; // pryv parser uses the union; SMART will widen
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

// --- Default `pryv` parser ---

const PRYV_PERMISSIONS = new Set(['read', 'write', 'manage']);

function pryvParser (body: string): ParsedScope {
  if (!PRYV_PERMISSIONS.has(body)) {
    throw new ScopeParseError(
      `unknown pryv scope permission "${body}" — expected one of: ${Array.from(PRYV_PERMISSIONS).join(', ')}`,
    );
  }
  return {
    namespace: 'pryv',
    raw: `pryv:${body}`,
    permission: body as 'read' | 'write' | 'manage',
  };
}

function _registerDefault (): void {
  registry.set('pryv', pryvParser);
}

_registerDefault();
