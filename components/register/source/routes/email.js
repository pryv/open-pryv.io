/**
 * @license
 * Copyright (C) 2020-2021 Pryv S.A. https://pryv.com 
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
 */
// @flow

// check if an EMAIL exists
const checkAndConstraints = require('../utils/check-and-constraints');
const db = require('../storage/database');
const messages = require('../utils/messages');
const config = require('../config');

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
  if (config.get('routes:disableGetUsernameByEmail')) {
    return Promise.reject(messages.e(405, 'DISABLED_METHOD'));
  }
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

