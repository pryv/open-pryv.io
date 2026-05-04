/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
import type {} from "node:fs";


/**
 * Helper for writing parallel-safe tests with isolated data
 *
 * Usage:
 *   const { createTestContext } = require('test-helpers/src/parallelTestHelper');
 *
 *   describe('My tests', function () {
 *     const ctx = createTestContext();
 *
 *     before(async function () {
 *       await ctx.init();
 *       // ctx.user - test user
 *       // ctx.token - personal access token
 *       // ctx.request - supertest instance for API calls
 *       // ctx.fixtures - databaseFixture for creating more data
 *     });
 *
 *     after(async function () {
 *       await ctx.cleanup();
 *     });
 *
 *     it('should do something', async function () {
 *       const res = await ctx.request
 *         .get(`/${ctx.username}/events`)
 *         .set('Authorization', ctx.token);
 *       assert.strictEqual(res.status, 200);
 *     });
 *   });
 */

const cuid = require('cuid');
const storage = require('storage');
const databaseFixture = require('./databaseFixture');

/**
 * Creates an isolated test context for parallel-safe testing
 * @param {Object} options
 * @param {string} options.password - User password (default: 'test-password')
 * @param {string} options.prefix - Username prefix (default: 'test')
 * @returns {TestContext}
 */
function createTestContext (options: any = {}) {
  const testRunId = cuid.slug();
  const password = options.password || 'test-password';
  const prefix = options.prefix || 'test';

  const ctx = {
    testRunId,
    username: `${prefix}-${testRunId}`,
    password,
    token: null,
    user: null,
    fixtures: null,
    request: null,
    server: null,
    serverUrl: null,

    /**
     * Initialize the test context
     * For Pattern C tests (in-process), just creates fixtures
     * For Pattern A tests, also starts a server
     */
    async init (serverOptions) {
      // Get StorageLayer (engine-agnostic)
      const storageLayer = await storage.getStorageLayer();
      ctx.fixtures = databaseFixture(storageLayer);

      // Create test user
      ctx.user = await ctx.fixtures.user(ctx.username, { password: ctx.password });

      // Create personal access token
      ctx.token = cuid();
      await ctx.user.access({
        type: 'personal',
        token: ctx.token,
        name: 'test-app'
      });
      await ctx.user.session(ctx.token);

      // If server options provided, start a dynamic server (Pattern A)
      if (serverOptions) {
        const DynamicInstanceManager = require('./DynamicInstanceManager');
        const { getConfig } = require('@pryv/boiler');

        const config = await getConfig();
        const settings = config.get();

        ctx.server = new DynamicInstanceManager({
          serverFilePath: serverOptions.serverFilePath
        });

        await ctx.server.ensureStartedAsync(settings);
        ctx.serverUrl = ctx.server.url;

        // Create superagent-based request helper for real HTTP
        const superagent = require('superagent');
        ctx.request = {
          get: (path) => superagent.get(ctx.serverUrl + path),
          post: (path) => superagent.post(ctx.serverUrl + path),
          put: (path) => superagent.put(ctx.serverUrl + path),
          del: (path) => superagent.del(ctx.serverUrl + path),
          delete: (path) => superagent.delete(ctx.serverUrl + path)
        };
      } else {
        // Pattern C - use global coreRequest if available
        if (global.coreRequest) {
          ctx.request = global.coreRequest;
        }
      }

      return ctx;
    },

    /**
     * Create a stream for the test user
     */
    async createStream (streamData: any = {}) {
      const id = streamData.id || `stream-${cuid.slug()}`;
      return ctx.user.stream({ id, name: streamData.name || id, ...streamData });
    },

    /**
     * Create an event for the test user
     */
    async createEvent (streamId, eventData: any = {}) {
      const stream = await ctx.createStream({ id: streamId });
      return stream.event({
        type: eventData.type || 'note/txt',
        content: eventData.content || 'test content',
        ...eventData
      });
    },

    /**
     * Create an additional access token
     */
    async createAccess (accessData: any = {}) {
      const token = accessData.token || cuid();
      await ctx.user.access({
        type: accessData.type || 'app',
        token,
        name: accessData.name || `access-${cuid.slug()}`,
        permissions: accessData.permissions || [{ streamId: '*', level: 'read' }],
        ...accessData
      });
      return token;
    },

    /**
     * Get the base path for API requests
     */
    basePath (suffix = '') {
      return `/${ctx.username}${suffix}`;
    },

    /**
     * Cleanup test data and stop server
     */
    async cleanup () {
      if (ctx.fixtures) {
        await ctx.fixtures.clean();
      }
      if (ctx.server) {
        ctx.server.stop();
      }
    }
  };

  return ctx;
}

module.exports = {
  createTestContext
};
