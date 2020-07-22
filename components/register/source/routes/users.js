/**
 * @license
 * Copyright (C) 2020 Pryv S.A. https://pryv.com - All Rights Reserved
 * Unauthorized copying of this file, via any medium is strictly prohibited
 * Proprietary and confidential
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

