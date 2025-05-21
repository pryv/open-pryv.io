/**
 * @license
 * Copyright (C) 2020–2025 Pryv S.A. https://pryv.com
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
const superagent = require('superagent');
const assert = require('chai').assert;
module.exports = request;
/**
 * Helper for HTTP requests. Returns a SuperAgent request:
 * - that sets the `authorization` header with the given token if any
 * - that always succeeds regardless of the HTTP status code (see SuperAgent's `ok()` method)
 * - whose `end()` method calls the given callback function with a single argument if expected
 * @returns {Request}
 */
function request (serverURL) {
  return new Request(serverURL);
}
/**
 * @returns {void}
 */
function Request (serverURL) {
  this.serverURL = serverURL;
  this.token = null;
}
['get', 'post', 'put', 'del', 'options'].forEach((method) => {
  Request.prototype[method] = function (...args) {
    return this.execute(method, ...args);
  };
});
Request.prototype.execute = function (method, path, token) {
  if (method === 'del') {
    method = 'delete';
  }
  const destURL = new URL(path, this.serverURL).href;
  const authToken = token || this.token;
  return new PryvTestRequest(method, destURL)
    .ok(() => true)
    .set('authorization', authToken);
};
/**
 * @param {Function} callback (error)
 */
Request.prototype.login = function (user, callback) {
  const targetURL = new URL(user.username + '/auth/login', this.serverURL).href;
  const authData = {
    username: user.username,
    password: user.password,
    appId: 'pryv-test'
  };
  return superagent
    .post(targetURL)
    .set('Origin', 'http://test.pryv.local')
    .send(authData)
    .end(function (err, res) {
      assert.isNull(err?.message || null, 'Request must be a success');
      assert.isDefined(res, 'Request has a result');
      res.statusCode.should.eql(200);
      if (res.body.token == null) {
        return callback(new Error('Expected "token" in login response body.'));
      }
      this.token = res.body.token;
      callback();
    }.bind(this));
};
/**
 * SuperAgent request sub-constructor.
 *
 * NOTE: This can be removed if/when we don't need the `end()` override (see below).
 * @returns {void}
 */
function PryvTestRequest (method, url) {
  superagent.Request.call(this, method, url);
}
PryvTestRequest.prototype = Object.create(superagent.Request.prototype);
/**
 * Overrides SuperAgent's `end()` to call the given callback function with a
 * single argument (the HTTP response object) _if the callback expects just
 * one argument_.
 */
PryvTestRequest.prototype.end = function (callback) {
  superagent.Request.prototype.end.call(this, (err, res) => {
    callback.length === 1 ? callback(res || err) : callback(err, res);
  });
};
