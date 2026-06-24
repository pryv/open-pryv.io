/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/**
 * OAuth2 route mount + host-app wiring.
 *
 * Builds the two callbacks the oauth2 component needs from the rest of
 * the api-server:
 *
 *   - `resolveUser({username, userToken})` — constructs a MethodContext
 *     for the user, validates the personal access token via
 *     `retrieveExpandedAccess`, returns a session handle carrying the
 *     populated context. Returns null on validation failure (errors
 *     from the access lookup surface as APIError; we swallow into null
 *     so the OAuth endpoint can render a 401 cleanly).
 *
 *   - `createAccess({session, clientId, scope, expiresAt})` — runs
 *     the full `accesses.create` method on behalf of the resolved
 *     user, so all the existing hooks (validation, CMC, etc.) fire.
 *     Maps the coarse-grained OAuth scope tokens to per-stream
 *     permissions (the App account is the OAuth client; the access
 *     is created on the user's home core).
 *
 * Then hands both off to `oauth2.registerRoutes`. If `service:api`,
 * `auth:adminAccessKey`, or `oauth:consentUrl` is missing, the oauth2
 * module soft-degrades with a warn — see its routes.ts.
 */

import type { Application as ExpressApp } from 'express';
import type { AppLike } from './_types.ts';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

const oauth2 = require('oauth2');
const { MethodContext } = require('business');
const storages = require('storages');
const cuid = require('cuid');

// Map a coarse OAuth scope token to a Pryv permission entry on the
// `*` wildcard stream id. This matches how /reg/access typically
// grants top-level scope (read/contribute/manage on all streams);
// finer-grained scope grammars can layer on later via the scope
// registry's pluggable parsers.
function scopeToPermission (scopeToken: string): { streamId: string; level: string } | null {
  if (scopeToken === 'pryv:read') return { streamId: '*', level: 'read' };
  if (scopeToken === 'pryv:write') return { streamId: '*', level: 'contribute' };
  if (scopeToken === 'pryv:manage') return { streamId: '*', level: 'manage' };
  return null;
}

function scopesToPermissions (scope: string[]): Array<{ streamId: string; level: string }> {
  const perms: Array<{ streamId: string; level: string }> = [];
  for (const s of scope) {
    const p = scopeToPermission(s);
    if (p != null) perms.push(p);
  }
  return perms;
}

export default function mountOAuth2 (expressApp: ExpressApp, app: AppLike): void {
  const config = app.config;
  const storageLayer = app.storageLayer;
  const api = app.api;

  // ---------------------------------------------------------------------
  // resolveUser — validates {username, userToken} via MethodContext.
  // customAuthStepFn is resolved lazily on each request (matches the
  // initContext middleware pattern — load only when a request hits).
  // ---------------------------------------------------------------------
  async function resolveUser ({ username, userToken }: { username: string; userToken: string }) {
    const customAuthStepFn = app.getCustomAuthFunction != null
      ? app.getCustomAuthFunction('oauth2.resolveUser')
      : null;
    const context: any = new MethodContext(
      { name: 'oauth2', ip: null },
      username,
      userToken,
      customAuthStepFn,
      {},
      {},
      null,
    );
    try {
      await context.init();
      await context.retrieveExpandedAccess(storageLayer);
    } catch (err) {
      return null;
    }
    if (context.access == null) return null;
    return {
      userId: context.user.id,
      username: context.user.username,
      // Carry the live context through so createAccess can call api on it.
      _context: context,
    };
  }

  // ---------------------------------------------------------------------
  // createAccess — calls accesses.create under the resolved user's auth
  // ---------------------------------------------------------------------
  async function createAccess ({ session, clientId, scope, expiresAt }: {
    session: { userId: string; username: string; [k: string]: unknown };
    clientId: string;
    scope: string[];
    expiresAt: number;
  }): Promise<{ accessId: string; accessToken: string; apiEndpoint: string }> {
    const context: any = session._context;
    if (context == null) {
      throw new Error('oauth2.createAccess: session missing _context (resolveUser did not run?)');
    }
    const permissions = scopesToPermissions(scope);
    const expireAfter = Math.max(0, Math.floor((expiresAt - Date.now()) / 1000));
    // Pryv enforces (type, name, deviceName) uniqueness on access rows.
    // Every OAuth authorize-then-token flow mints a fresh access (its
    // own refresh-token chain) — disambiguate via a session-unique
    // deviceName, keeping the human-readable name on the clientId.
    const params = {
      type: 'app',
      name: 'oauth:' + clientId,
      deviceName: 'oauth-session-' + cuid(),
      permissions,
      expireAfter,
    };
    // The api dispatcher reads this off the context (set by setMethodId
    // middleware on the normal route path; we set it directly here).
    context.methodId = 'accesses.create';
    return await new Promise((resolve, reject) => {
      api.call(context, params, (err: unknown, result: any) => {
        if (err != null) return reject(err);
        const a = result?.access;
        if (a == null || typeof a.id !== 'string' || typeof a.token !== 'string') {
          return reject(new Error('oauth2.createAccess: accesses.create returned no usable access'));
        }
        resolve({
          accessId: a.id,
          accessToken: a.token,
          apiEndpoint: typeof a.apiEndpoint === 'string' ? a.apiEndpoint : '',
        });
      });
    });
  }

  // ---------------------------------------------------------------------
  // mintRefreshedAccess — storage-layer-direct path used at /oauth2/token
  // refresh-grant time, when the user is no longer present. The original
  // accesses.create chain ran at /accept and already validated the grant;
  // refresh rotates credentials, never widens authority. Falls back to
  // ApiEndpoint.build for the new token's apiEndpoint URL.
  // ---------------------------------------------------------------------
  async function mintRefreshedAccess ({ userId, username, clientId, scope, expiresAt }: {
    userId: string; username: string; clientId: string; scope: string[]; expiresAt: number;
  }): Promise<{ accessId: string; accessToken: string; apiEndpoint: string }> {
    if (typeof username !== 'string' || username.length === 0) {
      throw new Error('mintRefreshedAccess: username required');
    }
    const accessesRepository = (storageLayer as any).accesses;
    if (accessesRepository == null) {
      throw new Error('mintRefreshedAccess: storageLayer.accesses unavailable');
    }
    const permissions = scopesToPermissions(scope);
    const now = Math.floor(Date.now() / 1000);
    const newToken = accessesRepository.generateToken();
    const newAccessRow: any = {
      type: 'app',
      name: 'oauth:' + clientId,
      deviceName: 'oauth-session-' + cuid(),
      token: newToken,
      permissions,
      created: now,
      createdBy: 'system',
      modified: now,
      modifiedBy: 'system',
      expires: Math.floor(expiresAt / 1000),
    };
    const ApiEndpoint = require('utils').ApiEndpoint;
    return await new Promise((resolve, reject) => {
      accessesRepository.insertOne({ id: userId, username }, newAccessRow,
        (err: any, newAccess: any) => {
          if (err != null) return reject(err);
          if (newAccess == null || typeof newAccess.id !== 'string' || typeof newAccess.token !== 'string') {
            return reject(new Error('mintRefreshedAccess: accesses.insertOne returned no usable access'));
          }
          resolve({
            accessId: newAccess.id,
            accessToken: newAccess.token,
            apiEndpoint: ApiEndpoint.build(username, newAccess.token),
          });
        });
    });
  }

  oauth2.registerRoutes(expressApp, {
    config,
    platform: storages.platformDB,
    mintRefreshedAccess,
    resolveUser,
    createAccess,
  });
}
