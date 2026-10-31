/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/**
 * OAuth2 route mount + host-app wiring.
 *
 * Builds the callbacks the oauth2 component needs from the rest of the
 * api-server, then hands them to `oauth2.registerRoutes`:
 *
 *   - `resolveUser({username, userToken})` (here): constructs a
 *     MethodContext for the user, validates the personal access token via
 *     `retrieveExpandedAccess`, returns a session handle carrying the
 *     populated context. Returns null on validation failure (errors from the
 *     access lookup surface as APIError; we swallow into null so the OAuth
 *     endpoint can render a 401 cleanly).
 *   - the consent records and the session minted at /accept
 *     (`oauth2/grants.ts`);
 *   - the storage-direct session paths used at /token (`oauth2/sessions.ts`);
 *   - the refresh-chain collapse on reuse (`oauth2/revoke.ts`);
 *   - the operator's OAuth extension, loaded here at mount.
 *
 * If `service:api`, the state key (`oauth:stateKey`, or `auth:adminAccessKey`
 * while it is unset), or `oauth:consentUrl` is missing, the oauth2 module
 * soft-degrades: see its routes.ts. A malformed `oauth:signingKeys` entry
 * fails the mount (and so the boot), like a broken extension.
 */

import type { Application as ExpressApp } from 'express';
import type { AppLike } from './_types.ts';
import type { Ctx, OAuthMethodResult, GlueEnv } from './oauth2/types.ts';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

const oauth2 = require('oauth2');
const delegation = require('delegation');
const { getLogger } = require('@pryv/boiler');
const { MethodContext } = require('business');
const storages = require('storages');
const { ExtensionLoader } = require('utils').extension;
const { createSessions } = require('./oauth2/sessions.ts');
const { createGrants } = require('./oauth2/grants.ts');
const { createRevoke } = require('./oauth2/revoke.ts');

export default function mountOAuth2 (expressApp: ExpressApp, app: AppLike): void {
  const config = app.config;
  const storageLayer = app.storageLayer;
  const api = app.api;
  const logger = getLogger('routes:oauth2');

  // ---------------------------------------------------------------------
  // resolveUser: validates {username, userToken} via MethodContext.
  // customAuthStepFn is resolved lazily on each request (matches the
  // initContext middleware pattern: load only when a request hits).
  // ---------------------------------------------------------------------
  async function resolveUser ({ username, userToken }: { username: string; userToken: string }) {
    const customAuthStepFn = app.getCustomAuthFunction != null
      ? app.getCustomAuthFunction('oauth2.resolveUser')
      : null;
    const context: Ctx = new MethodContext(
      { name: 'oauth2', ip: null },
      username,
      userToken,
      customAuthStepFn,
      {},
      {},
      null
    );
    try {
      await context.init();
      await context.retrieveExpandedAccess(storageLayer);
    } catch (err) {
      // Swallowed on purpose: the endpoint renders a clean 401 rather
      // than leaking why. Record it on the server trail: without this,
      // every context/auth failure is an indistinguishable null.
      logger.warn('resolveUser: context init/access lookup failed', err);
      return null;
    }
    if (context.access == null) {
      logger.warn('resolveUser: no access on context after retrieveExpandedAccess');
      return null;
    }
    // A token obtained through account delegation acts on this account for
    // the delegate. The OAuth access (and its refresh-minted successors) is
    // written outside accesses.create and would carry no delegation lineage,
    // so it would outlive the delegation: only the owner may consent here.
    if (delegation.isDelegationDerivedAccess(context.access)) {
      return {
        refused: true as const,
        description: 'A token obtained through account delegation cannot grant OAuth access; ' +
          'the account owner must sign in and consent.',
      };
    }
    // Only the account owner consents: the session and the grant are written
    // storage-direct or on this context, so the principal check is explicit
    // here rather than left to the access-creation rules downstream.
    const access = context.access as { isPersonal?: () => boolean; created?: number } | null;
    if (!(typeof access?.isPersonal === 'function' && access.isPersonal() === true)) {
      return { refused: true as const, description: 'only the account owner can grant OAuth access' };
    }
    return {
      userId: context.user.id,
      username: context.user.username,
      personal: true,
      // The personal access is created at sign-in (a later sign-in for the
      // same app rotates its token and keeps it): the OpenID Connect
      // `auth_time`, never later than the real authentication.
      ...(Number.isFinite(access.created) ? { authTime: Math.floor(access.created as number) } : {}),
      // Carry the live context through so createAccess can call api on it.
      _context: context,
    };
  }

  // ---------------------------------------------------------------------
  // apiCall: run an API method on an already-authenticated context.
  // The api dispatcher reads methodId off the context (set by the
  // setMethodId middleware on the normal route path; we set it here).
  // ---------------------------------------------------------------------
  async function apiCall (context: Ctx, methodId: string, params: Record<string, unknown>): Promise<OAuthMethodResult> {
    context.methodId = methodId;
    return await new Promise((resolve, reject) => {
      api.call(context, params, (err: unknown, result: unknown) => {
        if (err != null) return reject(err);
        resolve(result as OAuthMethodResult);
      });
    });
  }

  // ---------------------------------------------------------------------
  // The operator's OAuth extension (customExtensions:oauthExtension), loaded
  // at mount: a broken module fails the boot, not a user's first consent.
  // ---------------------------------------------------------------------
  function loadOAuthExtension (): unknown {
    const extensionPath = String(config.get('customExtensions:oauthExtension') ?? '');
    if (extensionPath === '') return null;
    const loader = new ExtensionLoader(String(config.get('customExtensions:defaultFolder') ?? ''));
    const ext = oauth2.extension.createExtension(loader.loadFrom(extensionPath).fn, {
      options: config.get('oauth:extensionOptions') ?? {},
      logger: getLogger('oauth2:extension'),
    });
    logger.info('OAuth extension loaded: ' + ext.name + ' (' + extensionPath + ')');
    return ext;
  }

  const env: GlueEnv = { config, storageLayer, logger, apiCall };
  const sessions = createSessions(env);
  const grants = createGrants(env, sessions);
  const { revokeChain } = createRevoke(env);

  oauth2.registerRoutes(expressApp, {
    config,
    extension: loadOAuthExtension(),
    resolveGrantSubject: sessions.resolveGrantSubject,
    platform: storages.platformDB,
    mintRefreshedAccess: sessions.mintRefreshedAccess,
    mintClientAccess: sessions.mintClientAccess,
    resolveAccountUserId: sessions.resolveAccountUserId,
    revokeChain,
    bindAccessDpop: sessions.bindAccessDpop,
    resolveAccess: sessions.resolveAccess,
    revokeAccessLocal: sessions.revokeAccessLocal,
    resolveUsername: sessions.resolveUsername,
    resolveUser,
    createAccess: grants.createAccess,
    readRegistryGrant: grants.readRegistryGrant,
  });
}
