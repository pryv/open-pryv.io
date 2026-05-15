/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

/**
 * CMC plugin — outbound HTTPS client tests.
 *
 * [CMCOUT] covers parseApiEndpoint + postToPeer + isRetryableFailure.
 * Tests inject a fake fetch so they're hermetic.
 */

const assert = require('node:assert/strict');
const {
  parseApiEndpoint,
  postToPeer,
  isRetryableFailure,
  DEFAULT_TIMEOUT_MS,
} = require('../src/outbound.ts');

function fakeFetch (responses) {
  // responses can be:
  //   - a single response spec (status, body) used for every call
  //   - an array of specs used in order
  //   - a function (url, init) => Promise<...>
  const calls = [];
  let nextIdx = 0;
  function nextResponse (url, init) {
    calls.push({ url, init });
    if (typeof responses === 'function') return responses(url, init);
    const spec = Array.isArray(responses) ? responses[nextIdx++] : responses;
    if (spec instanceof Error) return Promise.reject(spec);
    return Promise.resolve({
      status: spec.status,
      ok: spec.status >= 200 && spec.status < 300,
      async json () { return spec.body; },
      async text () { return JSON.stringify(spec.body); },
    });
  }
  return { fetch: nextResponse, calls };
}

describe('[CMCOUT] cmc/outbound', () => {
  describe('[CMCOUT-PE] parseApiEndpoint', () => {
    it('[CO01] splits a token-bearing apiEndpoint into token + base', () => {
      assert.deepEqual(
        parseApiEndpoint('https://AbCxYz@example.com/'),
        { token: 'AbCxYz', base: 'https://example.com/' }
      );
    });

    it('[CO02] adds a trailing slash if missing', () => {
      const r = parseApiEndpoint('https://Tok@example.com');
      assert.equal(r.token, 'Tok');
      assert.ok(r.base.endsWith('/'));
    });

    it('[CO03] supports non-default ports', () => {
      assert.deepEqual(
        parseApiEndpoint('https://Tok@example.com:8443/'),
        { token: 'Tok', base: 'https://example.com:8443/' }
      );
    });

    it('[CO04] rejects a URL without a token', () => {
      assert.throws(
        () => parseApiEndpoint('https://example.com/'),
        /must carry a token/
      );
    });

    it('[CO05] rejects an empty string', () => {
      assert.throws(
        () => parseApiEndpoint(''),
        /must be a non-empty string/
      );
    });
  });

  describe('[CMCOUT-PP] postToPeer', () => {
    it('[CO06] returns { ok: true, status, body } on 2xx', async () => {
      const { fetch, calls } = fakeFetch({ status: 201, body: { event: { id: 'e1' } } });
      const r = await postToPeer({
        apiEndpoint: 'https://Tok@example.com/',
        path: 'events',
        body: { type: 'message/chat-cmc', content: { content: 'hi' } },
        deps: { fetch },
      });
      assert.deepEqual(r, { ok: true, status: 201, body: { event: { id: 'e1' } } });
      assert.equal(calls.length, 1);
      assert.equal(calls[0].url, 'https://example.com/events');
      assert.equal(calls[0].init.method, 'POST');
      assert.equal(calls[0].init.headers.authorization, 'Tok');
    });

    it('[CO07] returns { ok: false, reason: http-4xx } on 400', async () => {
      const { fetch } = fakeFetch({ status: 400, body: { error: 'bad input' } });
      const r = await postToPeer({
        apiEndpoint: 'https://Tok@example.com/',
        path: 'events',
        body: {},
        deps: { fetch },
      });
      assert.equal(r.ok, false);
      assert.equal(r.reason, 'http-4xx');
      assert.equal(r.status, 400);
    });

    it('[CO08] returns { ok: false, reason: http-5xx } on 503', async () => {
      const { fetch } = fakeFetch({ status: 503, body: { error: 'down' } });
      const r = await postToPeer({
        apiEndpoint: 'https://Tok@example.com/',
        path: 'events',
        body: {},
        deps: { fetch },
      });
      assert.equal(r.ok, false);
      assert.equal(r.reason, 'http-5xx');
      assert.equal(r.status, 503);
    });

    it('[CO09] returns { ok: false, reason: network } on fetch rejection', async () => {
      const { fetch } = fakeFetch(new Error('ECONNREFUSED'));
      const r = await postToPeer({
        apiEndpoint: 'https://Tok@example.com/',
        path: 'events',
        body: {},
        deps: { fetch },
      });
      assert.equal(r.ok, false);
      assert.equal(r.reason, 'network');
      assert.equal(r.status, 0);
    });

    it('[CO10] passes the body as JSON in the request', async () => {
      const { fetch, calls } = fakeFetch({ status: 201, body: {} });
      await postToPeer({
        apiEndpoint: 'https://Tok@example.com/',
        path: 'events',
        body: { type: 'consent/request-cmc', content: { foo: 'bar' } },
        deps: { fetch },
      });
      const sentBody = JSON.parse(calls[0].init.body);
      assert.deepEqual(sentBody, { type: 'consent/request-cmc', content: { foo: 'bar' } });
    });

    it('[CO11] uses DEFAULT_TIMEOUT_MS unless overridden', async () => {
      // Smoke test that timeout default is plumbed through (not unit-asserting
      // the actual sleep, which would slow the suite).
      const { fetch } = fakeFetch({ status: 200, body: {} });
      const r = await postToPeer({
        apiEndpoint: 'https://Tok@example.com/',
        path: 'events',
        body: {},
        deps: { fetch },
      });
      assert.equal(r.ok, true);
      assert.ok(DEFAULT_TIMEOUT_MS > 0);
    });
  });

  describe('[CMCOUT-RF] isRetryableFailure', () => {
    it('[CO12] 4xx is NOT retryable', () => {
      assert.equal(
        isRetryableFailure({ ok: false, reason: 'http-4xx', status: 400, body: {} }),
        false
      );
    });

    it('[CO13] 5xx IS retryable', () => {
      assert.equal(
        isRetryableFailure({ ok: false, reason: 'http-5xx', status: 503, body: {} }),
        true
      );
    });

    it('[CO14] network failure IS retryable', () => {
      assert.equal(
        isRetryableFailure({ ok: false, reason: 'network', status: 0, error: 'ECONNREFUSED' }),
        true
      );
    });

    it('[CO15] timeout IS retryable', () => {
      assert.equal(
        isRetryableFailure({ ok: false, reason: 'timeout', status: 0 }),
        true
      );
    });

    it('[CO16] success is NOT retryable', () => {
      assert.equal(
        isRetryableFailure({ ok: true, status: 200, body: {} }),
        false
      );
    });
  });
});
