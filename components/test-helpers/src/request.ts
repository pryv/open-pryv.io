/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
import type {} from "node:fs";

const superagent = require('superagent');
const assert = require('node:assert');
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
      assert.strictEqual(err?.message || null, null, 'Request must be a success');
      assert.ok(res !== undefined, 'Request has a result');
      assert.strictEqual(res.statusCode, 200);
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
