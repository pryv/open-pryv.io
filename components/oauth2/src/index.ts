/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/**
 * OAuth2 component — public entry point.
 *
 * Re-exports the substrate: scope registry, error map, client registry,
 * well-known handler, audit helper, WWW-Authenticate builder, and the
 * routes barrel consumed by api-server's boot pipeline.
 */

import * as scopeRegistry from './scopeRegistry.ts';
import * as errorMap from './errorMap.ts';
import * as clientRegistry from './clientRegistry.ts';
import * as wellKnown from './wellKnown.ts';
import * as audit from './audit.ts';
import * as routes from './routes.ts';
import * as wwwAuthenticate from './wwwAuthenticate.ts';
import * as storage from './storage.ts';

export {
  scopeRegistry,
  errorMap,
  clientRegistry,
  wellKnown,
  audit,
  routes,
  wwwAuthenticate,
  storage,
};

// Convenience top-level re-exports — the most-frequently-used surface.
export const {
  registerScopeParser,
  parseScopes,
  listNamespaces,
  ScopeParseError,
} = scopeRegistry;

export const {
  mapError,
  buildErrorResponse,
} = errorMap;

export const {
  getClient,
  validateRedirectUri,
  persistClient,
  removeClient,
  listClientIds,
} = clientRegistry;

export const {
  buildDiscoveryDocument,
  handleWellKnown,
} = wellKnown;

export const { audit: emitAudit } = audit;

export const { registerRoutes } = routes;

export const {
  WWW_AUTHENTICATE_BEARER,
} = wwwAuthenticate;
