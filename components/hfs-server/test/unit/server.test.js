/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

const assert = require('node:assert');
const superagent = require('superagent');
const Application = require('../../src/application');

describe('[HFSV] Server', () => {
  const request = superagent;
  let application, server;
  before(async () => {
    application = new Application();
    await application.init();
    server = application.server;
  });
  function toUrl (path) {
    const baseUrl = server.baseUrl;
    return new URL(path, baseUrl).toString();
  }
  it('[O84I] can be constructed', function () {
    assert.ok(server);
  });
  describe('[HS01] .start', function () {
    beforeEach(async function () {
      await server.start();
    });
    afterEach(function () {
      server.stop();
    });
    it('[1VEL] starts a http server on configured port', function () {
      // Now we should have a local server running.
      const statusUrl = toUrl('/system/status');
      const response = request.get(statusUrl);
      return response.then((res) => {
        assert.strictEqual(res.status, 200);
      });
    });
  });
});
