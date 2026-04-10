/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/**
 * Login tests - Parallel-ready version
 * Uses DynamicInstanceManager for dynamic port allocation
 * Creates isolated test data to avoid conflicts with other tests
 *
 * Run with: npx mocha --config .mocharc.parallel.js
 */

// Initialize boiler config before anything else
process.env.NODE_ENV = 'test';
require('test-helpers/src/api-server-tests-config');

const assert = require('node:assert');
const path = require('path');
const cuid = require('cuid');
const request = require('superagent');
const storage = require('storage');

const { DynamicInstanceManager, databaseFixture } = require('test-helpers');
const { getConfig } = require('@pryv/boiler');
const ErrorIds = require('errors').ErrorIds;

describe('[AUTHP] auth (parallel)', function () {
  this.timeout(20000);

  // Unique identifiers for this test run
  const testRunId = cuid.slug();
  const username = `testuser-${testRunId}`;
  const password = 'test-password-123';
  const appId = 'pryv-test';
  const trustedOrigin = 'http://test.pryv.local';

  let server;
  let fixtures;
  let serverUrl;
  let user;

  function apiPath (user) {
    return new URL(user, serverUrl).href;
  }

  function basePath (user) {
    return apiPath(user) + '/auth';
  }

  before(async function () {
    // Initialize config
    const config = await getConfig();
    const settings = config.get();

    // Initialize DynamicInstanceManager
    server = new DynamicInstanceManager({
      serverFilePath: path.join(__dirname, '/../bin/server')
    });

    // Start server with dynamic ports
    await server.ensureStartedAsync(settings);
    serverUrl = server.url;

    // Setup test fixtures
    const storageLayer = await storage.getStorageLayer();
    fixtures = databaseFixture(storageLayer);

    // Create test user with unique username
    user = await fixtures.user(username, { password });

    // Create a personal access for login
    await user.access({
      type: 'personal',
      token: cuid(),
      name: appId
    });
  });

  after(async function () {
    // Cleanup
    if (fixtures) {
      await fixtures.context.cleanEverything();
    }
    if (server) {
      server.stop();
    }
  });

  describe('[AUP01] /login', function () {
    function path (user) {
      return basePath(user) + '/login';
    }

    const authData = {
      username,
      password,
      appId
    };

    it('[P2CV] must authenticate credentials and return access token', async function () {
      const res = await request
        .post(path(authData.username))
        .set('Origin', trustedOrigin)
        .send(authData);

      assert.strictEqual(res.statusCode, 200);
      assert.ok(res.body.token != null, 'should have token');
      assert.ok(res.body.apiEndpoint != null, 'should have apiEndpoint');
      assert.ok(res.body.apiEndpoint.includes(res.body.token), 'apiEndpoint should include token');
    });

    it('[P1TI] must not be case-sensitive for the username', async function () {
      const res = await request
        .post(path(authData.username))
        .set('Origin', trustedOrigin)
        .send(Object.assign({}, authData, { username: authData.username.toUpperCase() }));

      assert.strictEqual(res.statusCode, 200);
    });

    it('[PL7J] must return error when credentials are invalid', async function () {
      const data = Object.assign({}, authData, { password: 'bad-password' });

      const res = await request
        .post(path(data.username))
        .ok(() => true) // Don't throw on 4xx
        .set('Origin', trustedOrigin)
        .send(data);

      assert.strictEqual(res.statusCode, 401);
      assert.strictEqual(res.body.error.id, ErrorIds.InvalidCredentials);
    });

    it('[P4AQ] must return error if app id is untrusted', async function () {
      const data = Object.assign({}, authData, { appId: 'untrusted-app-id' });

      const res = await request
        .post(path(data.username))
        .ok(() => true)
        .set('Origin', trustedOrigin)
        .send(data);

      assert.strictEqual(res.statusCode, 401);
      assert.strictEqual(res.body.error.id, ErrorIds.InvalidCredentials);
    });

    it('[PNDB] must return error if origin does not match app id', async function () {
      const res = await request
        .post(path(authData.username))
        .ok(() => true)
        .set('Origin', 'http://mismatching.origin')
        .send(authData);

      assert.strictEqual(res.statusCode, 401);
      assert.strictEqual(res.body.error.id, ErrorIds.InvalidCredentials);
    });

    it('[P5UM] must reuse session if already open', async function () {
      // First login
      const res1 = await request
        .post(path(authData.username))
        .set('Origin', trustedOrigin)
        .send(authData);

      assert.strictEqual(res1.statusCode, 200);
      const originalToken = res1.body.token;

      // Second login - should reuse session
      const res2 = await request
        .post(path(authData.username))
        .set('Origin', trustedOrigin)
        .send(authData);

      assert.strictEqual(res2.statusCode, 200);
      assert.strictEqual(res2.body.token, originalToken, 'should reuse existing session');
    });
  });

  describe('[AUP02] /logout', function () {
    function loginPath (user) {
      return basePath(user) + '/login';
    }

    function logoutPath (user) {
      return basePath(user) + '/logout';
    }

    it('[P6W5] must terminate session and fail second logout', async function () {
      // Login first
      const loginRes = await request
        .post(loginPath(username))
        .set('Origin', trustedOrigin)
        .send({ username, password, appId });

      assert.strictEqual(loginRes.statusCode, 200);
      const token = loginRes.body.token;

      // First logout - should succeed
      const logoutRes1 = await request
        .post(logoutPath(username))
        .set('Authorization', token)
        .send({});

      assert.strictEqual(logoutRes1.statusCode, 200);

      // Second logout - should fail (session already closed)
      const logoutRes2 = await request
        .post(logoutPath(username))
        .ok(() => true)
        .set('Authorization', token)
        .send({});

      assert.strictEqual(logoutRes2.statusCode, 403);
      assert.strictEqual(logoutRes2.body.error.id, ErrorIds.InvalidAccessToken);
    });
  });
});
