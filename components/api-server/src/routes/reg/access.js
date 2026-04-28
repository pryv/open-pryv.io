/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/**
 * OAuth-style access authorization routes.
 * Implements the polling flow: create request → poll → accept/refuse.
 *
 * POST /reg/access       — create access request, return polling key
 * GET  /reg/access/:key  — poll access state
 * POST /reg/access/:key  — update state (ACCEPTED/REFUSED)
 */

const accessState = require('./accessState');

module.exports = function (expressApp, app) {
  /**
   * POST /reg/access — Create a new access request.
   */
  expressApp.post('/reg/access', (req, res) => {
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

    const { key, state } = accessState.create(req.body);

    // Build poll URL from the LOCAL core's URL — accessState is stored
    // in-memory per core, so every poll GET must hit the same core that
    // served the POST. Using the cluster-wide `service.register` URL
    // (e.g. https://reg.pryv.me/...) would round-robin across cores and
    // cause `unknown-access-key`. See _claude-memory/project_multicore_auth_pattern.md.
    //
    const serviceInfo = app.config.get('service') || {};
    const coreUrl = app.config.get('core:url');
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
    const defaultAuthUrl = app.config.get('access:defaultAuthUrl');
    let authUrl = null;
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

    const lang = req.body.languageCode || 'en';
    res.status(201).json({
      status: state.status,
      code: 201,
      key,
      requestingAppId: state.requestingAppId,
      requestedPermissions: state.requestedPermissions,
      authUrl,
      // @deprecated — kept for v1 SDK compatibility; new clients should
      // read `authUrl` instead. Remove once no in-the-wild SDK reads `url`.
      url: authUrl,
      poll: pollUrl,
      poll_rate_ms: state.poll_rate_ms,
      lang,
      returnURL: state.returnURL,
      // lib-js's NEED_SIGNIN state type declares `returnUrl` (camelCase).
      // Include both spellings for compatibility with v1 + v2 SDKs.
      returnUrl: state.returnURL,
      oauthState: state.oauthState,
      clientData: state.clientData,
      // v1-compatible: SDKs (lib-js) read service metadata from the
      // access-request response without round-tripping /service/info.
      //
      serviceInfo
    });
  });

  /**
   * GET /reg/access/:key — Poll access request state.
   */
  expressApp.get('/reg/access/:key', (req, res) => {
    const state = accessState.get(req.params.key);
    if (!state) {
      return res.status(400).json({
        error: { id: 'unknown-access-key', message: 'Unknown or expired access key' }
      });
    }

    // Embed service metadata in every poll response — app-web-auth3's
    // context.init() calls loadAccessState() and then
    // setServiceInfo(accessState.serviceInfo), which crashes with
    // "Cannot read properties of undefined (reading 'name')" if the
    // poll response is missing it.
    const serviceInfo = app.config.get('service') || {};

    const response = {
      status: state.status,
      code: state.code,
      serviceInfo
    };

    if (state.status === 'NEED_SIGNIN') {
      // Reconstruct poll + authUrl: lib-js's NEED_SIGNIN state type requires
      // them in every state-shaped payload, and some clients re-hydrate
      // their state from the poll response directly. The poll URL must be
      // core-affine (matches the POST-built URL) — store it on state at
      // creation time so GET and POST agree.
      response.key = state.key;
      response.requestingAppId = state.requestingAppId;
      response.requestedPermissions = state.requestedPermissions;
      response.poll = state.pollUrl || null;
      response.authUrl = state.authUrl || null;
      response.url = state.authUrl || null; // @deprecated — v1 alias
      response.poll_rate_ms = state.poll_rate_ms;
      response.lang = state.languageCode || 'en';
      response.returnURL = state.returnURL;
      response.returnUrl = state.returnURL;
      response.oauthState = state.oauthState;
      response.clientData = state.clientData;
    } else if (state.status === 'ACCEPTED') {
      response.username = state.username;
      response.token = state.token;
      response.apiEndpoint = state.apiEndpoint;
    } else if (state.status === 'REFUSED' || state.status === 'ERROR') {
      response.reasonID = state.reasonID;
      response.message = state.message;
    } else if (state.status === 'REDIRECTED') {
      // Multi-core: auth moved to another core, follow the new poll URL
      response.poll = state.redirectUrl;
    }

    res.status(state.code).json(response);
  });

  /**
   * POST /reg/access/:key — Update access request (accept or refuse).
   */
  expressApp.post('/reg/access/:key', (req, res) => {
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

    const state = accessState.update(req.params.key, req.body);
    if (!state) {
      return res.status(400).json({
        error: { id: 'unknown-access-key', message: 'Unknown or expired access key' }
      });
    }

    const response = {
      status: state.status,
      code: state.code
    };
    if (state.status === 'ACCEPTED') {
      response.username = state.username;
      response.token = state.token;
      response.apiEndpoint = state.apiEndpoint;
    } else if (state.status === 'REFUSED' || state.status === 'ERROR') {
      response.reasonID = state.reasonID;
      response.message = state.message;
    } else if (state.status === 'REDIRECTED') {
      response.poll = state.redirectUrl;
    }
    res.status(state.code).json(response);
  });

  /**
   * POST /access/invitationtoken/check — Check validity of an invitation token.
   * Returns plain text 'true' or 'false'.
   */
  expressApp.post('/access/invitationtoken/check', async (req, res) => {
    const token = req.body.invitationtoken;
    const { getPlatform } = require('platform');
    const platform = await getPlatform();
    const isValid = await platform.isInvitationTokenValid(token);
    res.type('text/plain').send(isValid ? 'true' : 'false');
  });
};
