/**
 * @license
 * Copyright (C) 2020–2024 Pryv S.A. https://pryv.com
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
const lodash = require('lodash');

const checkAndConstraints = require('../utils/check-and-constraints');
const users = require('../storage/users');
const messages = require('../utils/messages');
const invitations = require('../storage/invitations');
const requireRoles = require('../middleware/requireRoles');

/**
 * Routes for admin to manage users
 */
module.exports = function (app) {
  // GET /admin/users: get the user list
  app.get('/admin/users', requireRoles('admin'), function (req, res, next) {
    const headers = {
      registeredDate: 'Registered At',
      username: 'Username',
      email: 'e-mail',
      language: 'lang',
      server: 'Server',
      appid: 'From app',
      referer: 'Referer',
      invitationToken: 'Token',
      errors: 'Errors'
    };

    users.getAllUsersInfos(function (error, list) {
      if (error != null) return next(error);

      if (list == null) return next(new Error('AF: Missing user list.'));

      // Convert timestamp tor readable data
      const outputList = list
        .map((user) => {
          const output = lodash.clone(user);
          if (output.registeredTimestamp == null) {
            output.registeredTimestamp = 0;
            output.registeredDate = '';
          } else {
            output.registeredDate = new Date(
              parseInt(user.registeredTimestamp)
            ).toUTCString();
          }
          return output;
        })
        .sort((a, b) => b.registeredTimestamp - a.registeredTimestamp);

      if (req.query.toHTML) {
        return res.send(toHtmlTables(headers, outputList));
      }

      res.json({ users: outputList });
    });
  });

};

/**
 * @param {{
 *   [x: string]: string
 * }} headers
 * @returns {string}
 */
function toHtmlTables (headers, infoArray) {
  let result = '<table border="1">\n<tr>';
  Object.keys(headers).forEach(function (key) {
    result += '<th>' + headers[key] + '</th>';
  });
  result += '</tr>\n';

  infoArray.forEach(function (line) {
    result += '<tr>';
    Object.keys(headers).forEach(function (key) {
      let value = '';
      if (line[key]) {
        if (typeof line[key] === 'string') {
          value = line[key];
        } else {
          value = JSON.stringify(line[key]);
        }
      }
      result += '<td>' + value + '</td>';
    });

    result += '</tr>\n';
  });

  result += '</table>';
  return result;
}
