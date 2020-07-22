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
var authorizedKeys = require('../config').get('auth:authorizedKeys'),
    messages = require('../utils/messages');

/**
 * Returns a middleware function that checks request authorization (accepts either `Authorization`
 * header or `auth` query param) for the given roles.
 * Arguments are the authorized roles (e.g. "admin", "system", etc.).
 *
 */
module.exports = function getRequireRolesFN(/* role1, role2, etc. */) {
  var roles = (arguments.length === 1 && Array.isArray(arguments[0])) ?
      arguments[0] : [].slice.call(arguments);

  return function (req, res, next) {
    var auth = req.headers.authorization || req.query.auth;

    if (! auth || ! authorizedKeys[auth]) {
      return next(new messages.REGError(401, {
        id: 'unauthorized',
        message: 'Expected "Authorization" header or "auth" query parameter'
      }));
    }
    if (! req.context) {
      req.context = {};
    }

    var tempA = auth.split('|');
    var access = req.context.access = {
      username: (tempA.length > 0) ? res[0] : 'system',
      key: auth,
      roles: authorizedKeys[auth].roles
    };

    if (! access.roles.some(function (role) { return roles.indexOf(role) !== -1; })) {
      return next(new messages.REGError(403, {
        id: 'forbidden',
        message: 'Access forbidden'
      }));
    }
    next();
  };
};