/**
 * @license
 * Copyright (C) 2020 Pryv S.A. https://pryv.com - All Rights Reserved
 * Unauthorized copying of this file, via any medium is strictly prohibited
 * Proprietary and confidential
 */
// @flow

const messages = require('../utils/messages');
const checkAndConstraints = require('../utils/check-and-constraints');
const accessCommon = require('../business/access-lib');
const invitationToken = require('../storage/invitations');


const info = require('../business/service-info');
const Pryv = require('pryv');

/**
 * Routes handling applications access
 * @param app
 */
module.exports = function (app: express$Application) {

  /**
   * POST /access: request an access
   */
  app.post('/access', _requestAccess);

  /**
   * POST /access/invitationtoken/check: check validity of an invitation token
   */
  app.post('/access/invitationtoken/check', (req: express$Request, res) => {
    // FLOW We're assuming that body will be JSON encoded.
    const body: { [key: string]: string } = req.body;

    invitationToken.checkIfValid(body.invitationtoken, function (isValid/*, error*/) {
      res.header('Content-Type', 'text/plain');
      res.send(isValid ? 'true' : 'false');
    });
  });

  /** GET /access/:key - access polling with given key
   */
  app.get('/access/:key', (req: express$Request, res, next) => {
    accessCommon.testKeyAndGetValue(req.params.key, (value) => {
      value.serviceInfo = value.serviceInfo || info;
      return res.status(value.code).json(value);
    }, next);
  });

  /**
   * POST /access/:key: update state of access polling
   */
  app.post('/access/:key', (req: express$Request, res, next) => {
    // FLOW We're assuming that body will be JSON encoded.
    const body: { [key: string]: ?(string | number) } = req.body;

    const key = req.params.key;
    accessCommon.testKeyAndGetValue(key, function (previousValue) {

      let accessState = {
        status: 'ERROR',
        id: body.id,
        message: 'Unkown status code : ' + body.status,
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
        case 'ACCEPTED':
          var apiEndpoint = null;
          if (body.apiEndpoint) {
            apiEndpoint = checkAndConstraints.apiEndpoint(body.apiEndpoint);
            if (!apiEndpoint) {
              return next(messages.e(400, 'INVALID_API_ENDPOINT'));
            }
          } 

          // TO be deprecated
          var username = checkAndConstraints.uid(body.username);
          if (!username) {
            return next(messages.e(400, 'INVALID_USER_NAME'));
          }

          if (!checkAndConstraints.appToken(body.token)) {
            return next(messages.e(400, 'INVALID_DATA'));
          }


          if (!apiEndpoint) {
            apiEndpoint = Pryv.Service.buildAPIEndpoint(info, username, body.token)
          }

          accessState = {
            status: 'ACCEPTED',
            apiEndpoint: apiEndpoint,
            username: username, // should be deprecated
            token: body.token, // should be deprecated
            code: 200
          };
          break;
      }
      _setAccessState(res, next, key, accessState, previousValue);
    }, next);
  });
};

function _requestAccess(req: express$Request, res, next) {
  // FLOW We're assuming that body will be JSON encoded.
  const body: { [key: string]: ?string } = req.body;

  accessCommon.requestAccess(body, function (accessState) {
    accessState.serviceInfo = accessState.serviceInfo || info;
    res.status(accessState.code).json(accessState);
  }, next);
}


function _setAccessState(res, next, key, accessState, previousValue) {
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