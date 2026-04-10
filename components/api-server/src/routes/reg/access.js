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

    // Build poll URL from service config
    const serviceInfo = app.config.get('service') || {};
    const registerBase = serviceInfo.register || '/reg/';
    const pollUrl = registerBase + 'access/' + key;

    res.status(201).json({
      status: state.status,
      code: 201,
      key,
      requestingAppId: state.requestingAppId,
      requestedPermissions: state.requestedPermissions,
      poll: pollUrl,
      poll_rate_ms: state.poll_rate_ms,
      returnURL: state.returnURL,
      oauthState: state.oauthState,
      clientData: state.clientData
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

    const response = {
      status: state.status,
      code: state.code
    };

    if (state.status === 'NEED_SIGNIN') {
      response.key = state.key;
      response.requestingAppId = state.requestingAppId;
      response.requestedPermissions = state.requestedPermissions;
      response.poll_rate_ms = state.poll_rate_ms;
      response.returnURL = state.returnURL;
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
