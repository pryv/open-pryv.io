/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
/**
 * Unit tests for the rqlited readiness wait: the poll loop, its progress
 * warnings, the timeout error and the resolution of the configurable
 * budget (`storages.engines.rqlite.readyTimeoutMs`).
 *
 * These tests do NOT spawn rqlited. The /readyz endpoint is served by a
 * local node:http stub whose handler is swapped per case, so the loop runs
 * against real HTTP with millisecond budgets.
 */

const assert = require('node:assert/strict');
const http = require('node:http');
const {
  waitForReady,
  waitForExternal,
  resolveReadyTimeoutMs,
  DEFAULT_READY_TIMEOUT_MS
} = require('../src/rqliteProcess.ts');

describe('[RQREADY] rqliteProcess readiness wait', function () {
  this.timeout(5000);

  let server, baseUrl, handler, requestCount;

  before((done) => {
    server = http.createServer((req, res) => handler(req, res));
    server.listen(0, '127.0.0.1', () => {
      baseUrl = `http://127.0.0.1:${server.address().port}`;
      done();
    });
  });

  after((done) => server.close(done));

  beforeEach(() => {
    requestCount = 0;
    handler = neverReady();
  });

  /** Answers 503 for the first `n` requests, then 200. */
  function readyAfter (n) {
    return (req, res) => {
      requestCount++;
      res.writeHead(requestCount > n ? 200 : 503);
      res.end();
    };
  }

  function neverReady () {
    return (req, res) => {
      requestCount++;
      res.writeHead(503);
      res.end();
    };
  }

  function collector () {
    const messages = [];
    const fn = (msg) => messages.push(msg);
    fn.messages = messages;
    return fn;
  }

  it('[RQREADY1] resolves with the elapsed time once /readyz answers OK, without warning', async () => {
    handler = readyAfter(3);
    const warn = collector();

    const elapsed = await waitForReady(baseUrl, 2000, warn, 20);

    assert.equal(typeof elapsed, 'number');
    assert.ok(elapsed >= 0 && elapsed < 2000, `elapsed ${elapsed} out of range`);
    assert.deepEqual(warn.messages, [], 'no warning on a healthy start');
    assert.equal(requestCount, 4, '3 not-ready probes then the successful one');
  });

  it('[RQREADY2] warns once at 50% and once at 80%, then throws naming the URL and the config key', async () => {
    handler = neverReady();
    const warn = collector();

    await assert.rejects(
      () => waitForReady(baseUrl, 1000, warn, 50),
      (err) => {
        assert.ok(
          err.message.startsWith('rqlited did not become ready within 1000ms'),
          `unexpected message: ${err.message}`
        );
        assert.match(err.message, /storages\.engines\.rqlite\.readyTimeoutMs/);
        assert.match(err.message, /\/readyz/);
        return true;
      }
    );

    assert.equal(warn.messages.length, 2, `expected 2 warnings, got ${warn.messages.length}`);
    assert.match(warn.messages[0], /50% of the 1000ms budget/);
    assert.match(warn.messages[1], /80% of the 1000ms budget/);
    for (const msg of warn.messages) {
      assert.match(msg, /storages\.engines\.rqlite\.readyTimeoutMs/);
    }
  });

  it('[RQREADY3] treats a refused connection as not-ready and still times out cleanly', async () => {
    // Bind a throwaway server only to obtain a port nothing listens on.
    const closedPort = await new Promise((resolve) => {
      const tmp = http.createServer(() => {});
      tmp.listen(0, '127.0.0.1', () => {
        const { port } = tmp.address();
        tmp.close(() => resolve(port));
      });
    });
    const warn = collector();

    await assert.rejects(
      () => waitForReady(`http://127.0.0.1:${closedPort}`, 300, warn, 50),
      (err) => {
        assert.ok(
          err.message.startsWith('rqlited did not become ready within 300ms'),
          `unexpected message: ${err.message}`
        );
        return true;
      }
    );

    assert.ok(warn.messages.length >= 1, 'the 50% warning should have fired');
  });

  it('[RQREADY4] resolves the configured budget, and rejects values that are not a positive number of ms', () => {
    assert.equal(DEFAULT_READY_TIMEOUT_MS, 30000);
    assert.equal(resolveReadyTimeoutMs(undefined), 30000);
    assert.equal(resolveReadyTimeoutMs(null), 30000);
    assert.equal(resolveReadyTimeoutMs(45000), 45000);
    // Environment overrides arrive as strings.
    assert.equal(resolveReadyTimeoutMs('45000'), 45000);

    for (const bad of [0, -1, 'abc', NaN, '30s']) {
      assert.throws(
        () => resolveReadyTimeoutMs(bad),
        (err) => {
          assert.match(err.message, /storages\.engines\.rqlite\.readyTimeoutMs/);
          assert.match(err.message, /must be a positive number of milliseconds/);
          assert.ok(
            err.message.includes(JSON.stringify(bad)),
            `message should quote the offending value: ${err.message}`
          );
          return true;
        },
        `expected ${JSON.stringify(bad)} to be refused`
      );
    }
  });

  it('[RQREADY5] the external path defaults its budget and reports the elapsed time', async () => {
    handler = readyAfter(0);
    const log = collector();
    const warn = collector();

    await waitForExternal(baseUrl, undefined, log, warn);

    assert.equal(log.messages.length, 1);
    assert.match(log.messages[0], /^External rqlited HTTP API ready in \d+\.\ds$/);
    assert.deepEqual(warn.messages, []);

    // An explicit value reaches the loop.
    handler = neverReady();
    await assert.rejects(
      () => waitForExternal(baseUrl, 200, collector(), collector()),
      (err) => {
        assert.ok(
          err.message.startsWith('rqlited did not become ready within 200ms'),
          `unexpected message: ${err.message}`
        );
        return true;
      }
    );
  });
});
