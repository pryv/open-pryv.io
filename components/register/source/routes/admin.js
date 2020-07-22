/**
 * @license
 * Copyright (C) 2020 Pryv S.A. https://pryv.com - All Rights Reserved
 * Unauthorized copying of this file, via any medium is strictly prohibited
 * Proprietary and confidential
 */
// @flow

const lodash = require('lodash');

const checkAndConstraints = require('../utils/check-and-constraints');
const users = require('../storage/users');
const messages = require('../utils/messages');
const invitations = require('../storage/invitations');
const requireRoles = require('../middleware/requireRoles');

/**
 * Routes for admin to manage users
 */
module.exports = function (app: any) {
  // GET /admin/users: get the user list
  app.get('/admin/users', requireRoles('admin'), function (req, res, next) {
    const headers = {
      registeredDate : 'Registered At',
      username : 'Username',
      email: 'e-mail',
      language: 'lang',
      server: 'Server',
      appid: 'From app',
      referer: 'Referer',
      invitationToken : 'Token',
      errors: 'Errors'
    };

    users.getAllUsersInfos(function (error, list) {
      if (error != null)
        return next(error);

      if (list == null)
        return next(new Error('AF: Missing user list.'));

      // Convert timestamp tor readable data
      const outputList = list
        .map((user) => {
          const output: Object = lodash.clone(user);
          if (output.registeredTimestamp == null) {
            output.registeredTimestamp = 0;
            output.registeredDate = '';
          } else {
            output.registeredDate = new Date(parseInt(user.registeredTimestamp)).toUTCString();
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

function toHtmlTables(headers: {[string]: string}, infoArray) {
  var result = '<table border="1">\n<tr>';
  Object.keys(headers).forEach(function (key) {
    result += '<th>' + headers[key] + '</th>';
  });
  result += '</tr>\n';

  infoArray.forEach(function (line) {
    result += '<tr>';
    Object.keys(headers).forEach(function (key) {
      var value = '';
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