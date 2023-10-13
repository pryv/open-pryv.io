/**
 * @license
 * Copyright (C) 2020–2023 Pryv S.A. https://pryv.com
 *
 * This file is part of Open-Pryv.io and released under BSD-Clause-3 License
 *
 * Redistribution and use in source and binary forms, with or without
 * modification, are permitted provided that the following conditions are met:
 *
 * 1. Redistributions of source code must retain the above copyright notice,
 *   this list of conditions and the following disclaimer.
 *
 * 2. Redistributions in binary form must reproduce the above copyright notice,
 *   this list of conditions and the following disclaimer in the documentation
 *   and/or other materials provided with the distribution.
 *
 * 3. Neither the name of the copyright holder nor the names of its contributors
 *   may be used to endorse or promote products derived from this software
 *   without specific prior written permission.
 *
 * THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS"
 * AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE
 * IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
 * DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE
 * FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL
 * DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR
 * SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER
 * CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY,
 * OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
 * OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
 *
 * SPDX-License-Identifier: BSD-3-Clause
 */
const messages = require('../utils/messages');
const checkAndConstraints = require('../utils/check-and-constraints');
const accessCommon = require('../business/access-lib');
const invitationToken = require('../storage/invitations');

const info = require('../business/service-info');

/**
 * Routes handling applications access
 * @param app
 */
module.exports = function (app) {
  /**
   * POST /access: request an access
   */
  app.post('/access', _requestAccess);

  /**
   * POST /access/invitationtoken/check: check validity of an invitation token
   */
  app.post('/access/invitationtoken/check', (req, res) => {
    // We're assuming that body will be JSON encoded.
    const body = req.body;

    invitationToken.checkIfValid(body.invitationtoken, function (isValid /*, error */) {
      res.header('Content-Type', 'text/plain');
      res.send(isValid ? 'true' : 'false');
    });
  });

  /**
   * GET /access/:key - access polling with given key
   */
  app.get('/access/:key', (req, res, next) => {
    accessCommon.testKeyAndGetValue(req.params.key, (value) => {
      value.serviceInfo = value.serviceInfo || info;
      return res.status(value.code).json(value);
    }, next);
  });

  /**
   * POST /access/:key: update state of access polling
   */
  app.post('/access/:key', (req, res, next) => {
    // We're assuming that body will be JSON encoded.
    const body = req.body;

    const key = req.params.key;
    accessCommon.testKeyAndGetValue(key, function (previousValue) {
      let accessState = {
        status: 'ERROR',
        id: body.id,
        message: 'Unknown status code : ' + body.status,
        detail: '',
        code: 403
      };
      switch (body.status) {
        case 'REFUSED':
          accessState = {
            status: 'REFUSED',
            reasonID: body.reasonID || 'REASON_UNDEFINED',
            message: body.message || '',
            code: 403
          };
          break;
        case 'ERROR':
          accessState = {
            status: 'ERROR',
            id: body.id || 'INTERNAL_ERROR',
            message: body.message || '',
            detail: body.detail || '',
            code: 403
          };
          break;
        case 'ACCEPTED': {
          let apiEndpoint = null;
          if (body.apiEndpoint) {
            apiEndpoint = checkAndConstraints.apiEndpoint(body.apiEndpoint);
            if (!apiEndpoint) {
              return next(messages.e(400, 'INVALID_API_ENDPOINT'));
            }
          }
          // TO be deprecated
          const username = checkAndConstraints.uid(body.username);
          if (!username) {
            return next(messages.e(400, 'INVALID_USER_NAME'));
          }
          if (!checkAndConstraints.appToken(body.token)) {
            return next(messages.e(400, 'INVALID_DATA'));
          }
          if (!apiEndpoint) {
            apiEndpoint = info.getAPIEndpoint(username, body.token);
          }
          accessState = {
            status: 'ACCEPTED',
            apiEndpoint,
            username,
            token: body.token,
            code: 200
          };
          break;
        }
      }
      _setAccessState(res, next, key, accessState, previousValue);
    }, next);
  });
};

/**
 * @param {express$Request} req
 * @returns {void}
 */
function _requestAccess (req, res, next) {
  // We're assuming that body will be JSON encoded.
  const body = req.body;

  accessCommon.requestAccess(body, function (accessState) {
    accessState.serviceInfo = accessState.serviceInfo || info;
    res.status(accessState.code).json(accessState);
  }, next);
}

/**
 * @returns {void}
 */
function _setAccessState (res, next, key, accessState, previousValue) {
  if (previousValue && previousValue.serviceInfo) {
    accessState.serviceInfo = previousValue.serviceInfo;
  }

  accessCommon.setAccessState(key, accessState, function (accessState) {
    if (accessState.code != null) res.status(accessState.code);
    accessState.serviceInfo = accessState.serviceInfo || info;
    res.json(accessState);
  }, function (errorMessage) {
    next(errorMessage);
  });
}
