/**
 * @license
 * Copyright (C) 2020 Pryv S.A. https://pryv.com - All Rights Reserved
 * Unauthorized copying of this file, via any medium is strictly prohibited
 * Proprietary and confidential
 */
// @flow

// check if an EMAIL exists
const checkAndConstraints = require('../utils/check-and-constraints');
const db = require('../storage/database');
const messages = require('../utils/messages');

/**
 * Routes to handle emails
 * @param app
 */
module.exports = function (app: any) {
  /// POST /email/check/: check existence of an email
  /// 
  /// This will return a plaintext response that is either 'true' or 'false'. 
  /// Response will be 'true' if the email is valid AND free for the taking.
  /// 
  app.post('/email/check', function (req, res) {
    isEmailTaken(req.body.email).then((taken) => {
      const free = ! taken; 
      res.send(free.toString());
    }).catch(() => {
      res.send('false');
    });
  });

  /// GET /:email/check_email: check existence of an email
  /// 
  /// This will return an 'application/json' response that contains a single 
  /// field 'exists'. The value of that field will be true if the email address 
  /// is already registered with the system, false otherwise. 
  /// 
  /// NOTE This is not the same as the POST /email/check route above. For a valid
  ///  email address that has already been used, this method returns 
  /// 
  /// ```json    
  /// { exists: true }
  /// ```
  /// 
  /// where the above method would return `'false'`.
  /// 
  app.get('/:email/check_email', function (req, res, next) {
    isEmailTaken(req.params.email).then((taken) => {
      return res.json({exists: taken });
    }).catch(() => {
      return next(messages.e(400, 'INVALID_EMAIL'));
    });
  });

  /// GET /:email/uid: get username for a given email
  /// 
  /// NOTE: We keep this method for backward compatibility
  ///       but encourage the use of GET /:email/username instead
  /// 
  app.get('/:email/uid', function (req, res, next) {
    getUsernameFromEmail(req.params.email).then((username) => {
      return res.json({uid: username});
    }).catch((err) => {
      return next(err);
    });
  });

  /// GET /:email/username: get username for a given email
  ///
  app.get('/:email/username', function (req, res, next) {
    getUsernameFromEmail(req.params.email).then((username) => {
      return res.json({username: username});
    }).catch((err) => {
      return next(err);
    });
  });
};

/** Convert given email to corresponding username. 
 * 
 * @param email {string} email to convert
 * @throws {Error} if email has invalid format or not in use. 
 * @return {Promise<string>} resolves the corresponding username if the email is valid and in use.
 */
function getUsernameFromEmail(email: string): Promise<string> {
  if (checkAndConstraints.email(email) == null) {
    return Promise.reject(messages.e(400, 'INVALID_EMAIL'));
  }

  return new Promise((resolve, reject) => {
    db.getUIDFromMail(email, (error, username) => {
      if (error != null) return reject(messages.ei());
      if (username == null) return reject(messages.e(404, 'UNKNOWN_EMAIL'));

      resolve(username);
    });
  });
}

/** Checks if the email given in `email` is taken yet. 
 * 
 * @param email {string} string to check
 * @throws {Error} if the string doesn't look like an email address. 
 * @return {Promise<boolean>} resolves to true if the email is valid and already
 *    in use by a user. 
 */
function isEmailTaken(email: string): Promise<boolean> {
  if (! checkAndConstraints.email(email)) {
    return Promise.reject(new Error('invalid email'));
  }
  
  return new Promise((resolve, reject) => {
    db.emailExists(email, (err, result) => {
      if (err != null) return reject(err);

      if (result == null) return reject(new Error('AF: No result'));

      resolve(result);
    });
  });
}

