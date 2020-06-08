/**
 * @license
 * Copyright (c) 2020 Pryv S.A. https://pryv.com
 * 
 * This file is part of Open-Pryv.io and released under BSD-Clause-3 License
 * 
 * Redistribution and use in source and binary forms, with or without 
 * modification, are permitted provided that the following conditions are met:
 * 
 * 1. Redistributions of source code must retain the above copyright notice, 
 *    this list of conditions and the following disclaimer.
 * 
 * 2. Redistributions in binary form must reproduce the above copyright notice, 
 *    this list of conditions and the following disclaimer in the documentation 
 *    and/or other materials provided with the distribution.
 * 
 * 3. Neither the name of the copyright holder nor the names of its contributors 
 *    may be used to endorse or promote products derived from this software 
 *    without specific prior written permission.
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
 * 
 */
// @flow

const bluebird = require('bluebird');
const async = require('async');

const checkAndConstraints = require('../utils/check-and-constraints');
const messages = require('../utils/messages');
const users = require('../storage/users');
const requireRoles = require('../middleware/requireRoles');
const db = require('../storage/database');
const encryption = require('../utils/encryption');
const dataservers = require('../business/dataservers');
const reservedWords = require('../storage/reserved-userid');

/**
 * Routes for users
 * @param app
 */
module.exports = function (app: express$Application) {
  // POST /user: create a new user
  app.post('/user', (req: express$Request, res, next) => {
    // FLOW Assume body has this type.
    const body: {[string]: ?(string | number | boolean)} = req.body; 

    const hosting: ?string = checkAndConstraints.hosting(body.hosting);
    if (hosting == null) {
      return next(messages.e(400, 'INVALID_HOSTING'));
    }

    const appID = checkAndConstraints.appID(body.appid);
    const username = checkAndConstraints.uid(body.username);
    const password = checkAndConstraints.password(body.password);
    const email = checkAndConstraints.email(body.email);
    const givenInvitationToken = body.invitationtoken || 'no-token';
    const referer = checkAndConstraints.referer(body.referer);
    const language = checkAndConstraints.lang(body.languageCode);

    if (appID == null)      return next(messages.e(400, 'INVALID_APPID'));
    if (username == null)   return next(messages.e(400, 'INVALID_USER_NAME'));
    if (email == null)      return next(messages.e(400, 'INVALID_EMAIL'));
    if (password == null)   return next(messages.e(400, 'INVALID_PASSWORD'));
    if (language == null)  return next(messages.e(400, 'INVALID_LANGUAGE'));

    const existsList = [];
    async.parallel([
      function _isUserIdReserved(callback) {
        reservedWords.useridIsReserved(username, function (error, reserved) {
          if (reserved) {
            existsList.push('RESERVED_USER_NAME');
          }
          callback(error);
        });
      },
      function _doesUidAlreadyExist(callback) {
        db.uidExists(username, function (error, exists) {
          if (exists) {
            existsList.push('EXISTING_USER_NAME');
          }
          callback(error);
        });
      },
      function _doesEmailAlreadyExist(callback) {  // test email
        db.emailExists(email, function (error, exists) {
          if (exists) {
            existsList.push('EXISTING_EMAIL');
          }
          callback(error);
        });
      },
    ], function (error) {

      if (existsList.length > 0) {
        if (existsList.length === 1) 
          return next(messages.e(400, existsList[0]));
        
        return next(messages.ex(400, 'INVALID_DATA', existsList));
      }

      if (error != null) return next(messages.ei(error));

      encryption.hash(password, function (errorEncryt, passwordHash) {
        if (errorEncryt != null) return next(messages.ei(errorEncryt));

        // Create user
        dataservers.getCoreForHosting(hosting, (hostError, host) => {
          if (hostError != null) return next(messages.ei(hostError));
          if (host == null) return next(messages.e(400, 'UNAVAILABLE_HOSTING'));

          const userAttrs = {
            username: username, email: email, language: language, 
            password: password, passwordHash: passwordHash, 
            invitationToken: givenInvitationToken, referer: referer, 
            appid: appID
          };
          users.create(host, userAttrs, function(creationError, result) {
            if(creationError) {
              return next(messages.ei(creationError));
            }
            res.status(200).json(result);
          });
        });
      });
    });
  });


  /**
   * POST /username/check: check the existence/validity of a given username
   */
  app.post('/username/check', (req: express$Request, res, next) => {
    // FLOW Assume body has this type.
    const body: { [string]: ?(string | number | boolean) } = req.body; 

    req.params.username = body.username;
    _check(req, res, next, true);
  });

  /**
   * GET /:username/check_username: check the existence/validity of a given username
   */
  app.get('/:username/check_username', (req: express$Request, res, next) => {
    _check(req, res, next, false);
  });

};

// Checks if the username is valid. If `raw` is set to true, this will respond
// to the request directly, sending a 'text/plain' boolean response ('true' or
// 'false'). If `raw` is false, it will either call `next` with an error or 
// answer using the Content-Type 'application/json'. 
// 
// NOTE Yes. In fact, these are two functions that got tied up one in the other. 
// 
function _check(req: express$Request, res: express$Response, next: express$NextFunction, raw: boolean) {
  const username = checkAndConstraints.uid(req.params.username);

  if (! username) {
    if (raw) {
      res.header('Content-Type', 'text/plain');
      return res.send('false');
    } else {
      return next(messages.e(400, 'INVALID_USER_NAME'));
    }
  }

  reservedWords.useridIsReserved(username, function (error, reserved) {
    if (error) {
      return next(error);
    }

    if (reserved) {
      if (raw) {
        res.header('Content-Type', 'text/plain');
        return res.send('false');
      }
      return res.json({reserved: true, reason: 'RESERVED_USER_NAME' });
    }

    db.uidExists(username, function (error, exists) {
      if (error) {
        return next(messages.ei());
      }
      if (raw) {
        res.header('Content-Type', 'text/plain');
        return res.send(exists ? 'false' : 'true');
      } else {
        return res.json({reserved: exists });
      }
    });
  });
}

