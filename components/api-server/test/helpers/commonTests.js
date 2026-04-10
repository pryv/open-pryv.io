/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
/**
 * Regroups acceptance tests reused in different places.
 */

const request = require('superagent');

const validation = require('./validation');
const ErrorIds = require('errors').ErrorIds;

/**
 * @param {String} serverURL
 * @param {String} path
 */
exports.checkAccessTokenAuthentication = function (serverURL, path, done) {
  request.get(new URL(path, serverURL).toString()).end(function (err, res) { // eslint-disable-line n/handle-callback-err
    validation.check(res, {
      status: 401,
      id: ErrorIds.InvalidAccessToken
    }, done);
  });
};
