/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
import { createRequire } from 'node:module';
import type { Request, Response, NextFunction, Application as ExpressApp } from 'express';
const require = createRequire(import.meta.url);
/**
 * OAuth-style access authorization routes.
 * Implements the polling flow: create request → poll → accept/refuse.
 *
 * POST /reg/access       — create access request, return polling key
 * GET  /reg/access/:key  — poll access state
 * POST /reg/access/:key  — update state (ACCEPTED/REFUSED)
 */

const accessState = require('./accessState.ts');

type AppLike = {
  config: { get: (key: string) => unknown };
};
type PryvRequest = Request;

export default function (expressApp: ExpressApp, app: AppLike) {
  /**
   * POST /reg/access — Create a new access request.
   */
  expressApp.post('/reg/access', async (req: PryvRequest, res: Response, next: NextFunction) => {
    try {
      const { requestingAppId, requestedPermissions } = req.body;

      if (!requestingAppId || typeof requestingAppId !== 'string') {
        return res.status(400).json({
          error: { id: 'invalid-parameters', message: 'Missing or invalid requestingAppId' }
        });
      }
      if (!Array.isArray(requestedPermissions) || requestedPermissions.length === 0) {
        return res.status(400).json({
          error: { id: 'invalid-parameters', message: 'Missing or invalid requestedPermissions' }
        });
      }

      const { key, state, expiresAt } = accessState.buildState(req.body);

      // Build poll URL from the LOCAL core's URL — accessState is stored
      // per core, so every poll GET must hit the same core that served
      // the POST. Using the cluster-wide `service.register` URL (e.g.
      // https://reg.pryv.me/...) would round-robin across cores and
      // cause `unknown-access-key`.
      //
      const serviceInfo = (app.config.get('service') || {}) as Record<string, unknown> & { register?: string; api?: string };
      const coreUrl = app.config.get('core:url') as string | undefined;
      // core:url may be operator-supplied with or without trailing slash;
      // normalize so we don't emit `https://core.x//reg/...`.
      const coreUrlSlash = coreUrl
        ? (coreUrl.endsWith('/') ? coreUrl : coreUrl + '/')
        : null;
      const pollBase = coreUrlSlash ? coreUrlSlash + 'reg/' : (serviceInfo.register || '/reg/');
      const pollUrl = pollBase + 'access/' + key;

      // Build the popup auth-UI URL as `authUrl`. SDKs open this in a popup
      // for the user to sign in. Base URL comes from `access.defaultAuthUrl`
      // in config — operators deploy app-web-auth3 (or an equivalent auth UI)
      // at that address and set the config.
      const defaultAuthUrl = app.config.get('access:defaultAuthUrl') as string | undefined;
      let authUrl: string | null = null;
      if (defaultAuthUrl) {
        const sep = defaultAuthUrl.indexOf('?') >= 0 ? '&' : '?';
        const params = [
          'lang=' + encodeURIComponent(req.body.languageCode || 'en'),
          'key=' + encodeURIComponent(key),
          'requestingAppId=' + encodeURIComponent(requestingAppId),
          'poll=' + encodeURIComponent(pollUrl),
          'poll_rate_ms=' + state.poll_rate_ms,
          'serviceInfo=' + encodeURIComponent(serviceInfo.api ? (serviceInfo.register || '') + 'service/info' : '')
        ];
        if (state.returnURL) params.push('returnURL=' + encodeURIComponent(state.returnURL));
        if (state.oauthState) params.push('oauthState=' + encodeURIComponent(state.oauthState));
        authUrl = defaultAuthUrl + sep + params.join('&');
      }

      // Stash pollUrl + authUrl on state so GET /reg/access/:key can echo
      // them back verbatim (lib-js rehydrates state from the poll body).
      state.pollUrl = pollUrl;
      state.authUrl = authUrl;
      // Persist the fully-built state once — buildState only prepared the
      // shape; we write to PlatformDB here, after the URLs are computed.
      await accessState.persist(key, state, expiresAt);

      // Calling-app surface: only the fields the SDK needs to drive
      // the flow. The auth UI gets richer state from GET /reg/access/:key
      // (and from query parameters on `authUrl`). Service metadata
      // belongs at `/service/info` — clients fetch it from there.
      res.status(201).json({
        status: state.status,
        key,
        authUrl,
        poll: pollUrl,
        poll_rate_ms: state.poll_rate_ms
      });
    } catch (err) { next(err); }
  });

  /**
   * GET /reg/access/:key — Poll access request state.
   */
  expressApp.get('/reg/access/:key', async (req: PryvRequest, res: Response, next: NextFunction) => {
    try {
      const state = await accessState.get(req.params.key);
      if (!state) {
        return res.status(400).json({
          error: { id: 'unknown-access-key', message: 'Unknown or expired access key' }
        });
      }

      const response: Record<string, unknown> = {
        status: state.status
      };

      if (state.status === 'NEED_SIGNIN') {
        // Embed service metadata only on NEED_SIGNIN polls — that's where
        // the auth UI loads it during init. Later polls (lib-js polling
        // for ACCEPTED) don't need it; clients can hit `/service/info`
        // directly.
        response.serviceInfo = app.config.get('service') || {};
        response.key = state.key;
        response.requestingAppId = state.requestingAppId;
        response.requestedPermissions = state.requestedPermissions;
        response.poll = state.pollUrl || null;
        response.authUrl = state.authUrl || null;
        response.poll_rate_ms = state.poll_rate_ms;
        response.lang = state.languageCode || 'en';
        response.returnURL = state.returnURL;
        response.oauthState = state.oauthState;
        response.clientData = state.clientData;
      } else if (state.status === 'ACCEPTED') {
        response.username = state.username;
        response.token = state.token;
        response.apiEndpoint = state.apiEndpoint;
      } else if (state.status === 'REFUSED' || state.status === 'ERROR') {
        response.reasonId = state.reasonId;
        response.message = state.message;
      } else if (state.status === 'REDIRECTED') {
        // Multi-core: auth moved to another core; the SDK follows the
        // new poll URL. The auth UI receives the same field via the
        // POST update response and redirects the browser.
        response.poll = state.redirectUrl;
        response.redirectUrl = state.redirectUrl;
      }

      res.status(state.code).json(response);
    } catch (err) { next(err); }
  });

  /**
   * POST /reg/access/:key — Update access request (accept or refuse).
   */
  expressApp.post('/reg/access/:key', async (req: PryvRequest, res: Response, next: NextFunction) => {
    try {
      const { status } = req.body;

      if (!status || !['ACCEPTED', 'REFUSED', 'ERROR', 'REDIRECTED'].includes(status)) {
        return res.status(400).json({
          error: { id: 'invalid-parameters', message: 'status must be ACCEPTED, REFUSED, ERROR, or REDIRECTED' }
        });
      }

      if (status === 'ACCEPTED') {
        if (!req.body.username || !req.body.token) {
          return res.status(400).json({
            error: { id: 'invalid-parameters', message: 'ACCEPTED requires username and token' }
          });
        }
      }

      if (status === 'REDIRECTED') {
        if (!req.body.redirectUrl) {
          return res.status(400).json({
            error: { id: 'invalid-parameters', message: 'REDIRECTED requires redirectUrl' }
          });
        }
      }

      const state = await accessState.update(req.params.key, req.body);
      if (!state) {
        return res.status(400).json({
          error: { id: 'unknown-access-key', message: 'Unknown or expired access key' }
        });
      }

      const response: Record<string, unknown> = {
        status: state.status
      };
      if (state.status === 'ACCEPTED') {
        response.username = state.username;
        response.token = state.token;
        response.apiEndpoint = state.apiEndpoint;
      } else if (state.status === 'REFUSED' || state.status === 'ERROR') {
        response.reasonId = state.reasonId;
        response.message = state.message;
      } else if (state.status === 'REDIRECTED') {
        response.poll = state.redirectUrl;
        response.redirectUrl = state.redirectUrl;
      }
      res.status(state.code).json(response);
    } catch (err) { next(err); }
  });

  /**
   * POST /access/invitationtoken/check — Check validity of an invitation token.
   * Returns plain text 'true' or 'false'.
   */
  expressApp.post('/access/invitationtoken/check', async (req: PryvRequest, res: Response) => {
    const token = req.body.invitationtoken;
    const { getPlatform } = require('platform');
    const platform = await getPlatform();
    const isValid = await platform.isInvitationTokenValid(token);
    res.type('text/plain').send(isValid ? 'true' : 'false');
  });
};
