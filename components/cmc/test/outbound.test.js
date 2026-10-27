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
  stripCredentials,
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
      headers: { get: (name) => spec.headers?.[name.toLowerCase()] ?? null },
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

  describe('[CMCOUT-SC] stripCredentials', () => {
    it('[CO17] removes the token while keeping scheme, host, port and path', () => {
      assert.equal(stripCredentials('https://AbCxYz@example.com/'), 'https://example.com/');
      assert.equal(stripCredentials('https://Tok@example.com:8443/'), 'https://example.com:8443/');
      assert.equal(stripCredentials('https://Tok@example.com/some/path'), 'https://example.com/some/path');
    });

    it('[CO18] removes a user:password pair, not just a bare username', () => {
      assert.equal(stripCredentials('https://user:secret@example.com/'), 'https://example.com/');
    });

    it('[CO19] leaves a token-less URL alone and returns unparseable input unchanged', () => {
      assert.equal(stripCredentials('https://example.com/'), 'https://example.com/');
      assert.equal(stripCredentials('not a url'), 'not a url');
      assert.equal(stripCredentials(''), '');
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

    it('[CO21] a refused destination is NOT retryable', () => {
      assert.equal(
        isRetryableFailure({ ok: false, reason: 'refused', status: 0, kind: 'address', host: '10.0.0.1' }),
        false
      );
    });
  });

  describe('[CMCOUT-RF] refused destinations', () => {
    it('[CO20] a fetch refusing the destination yields reason refused, with kind and host', async () => {
      const refusal = Object.assign(new Error("peer call refused: address, host '10.0.0.1'"), { code: 'EPEERREFUSED', kind: 'address', host: '10.0.0.1' });
      const { fetch } = fakeFetch(refusal);
      const r = await postToPeer({ apiEndpoint: 'https://tok@10.0.0.1/', path: 'events', body: {}, deps: { fetch } });
      assert.deepEqual(r, { ok: false, reason: 'refused', status: 0, kind: 'address', host: '10.0.0.1' });
    });

    it('[CO22] with the guarded peerFetch, a private counterparty is refused before any connection', async () => {
      const { peerFetch, setPeerTransportForTests } = require('business/src/outbound/peerFetch.ts');
      const { compileAllowList } = require('business/src/webhooks/destination.ts');
      setPeerTransportForTests(null);
      const settings = { allow: compileAllowList([]), allowInsecure: false, isPlatformHost: () => false };
      const fetch = (url, init) => peerFetch(url, init, settings);
      for (const apiEndpoint of ['https://tok@10.0.0.1/', 'https://tok@[::1]/', 'https://tok@169.254.169.254/', 'http://tok@peer.example.com/']) {
        const r = await postToPeer({ apiEndpoint, path: 'events', body: {}, deps: { fetch } });
        assert.equal(r.ok, false, apiEndpoint);
        assert.equal(r.reason, 'refused', apiEndpoint);
        assert.equal(isRetryableFailure(r), false);
      }
    });

    it('[CO23] the retry queue never re-runs a refused destination', () => {
      const { isRetryableReason } = require('../src/retryQueue.ts');
      assert.equal(isRetryableReason('cmc-handler-destination-refused'), false);
      assert.equal(isRetryableReason('cmc-capability-destination-refused'), false);
      assert.equal(isRetryableReason('cmc-handler-delivery-failed', { peerReason: 'refused' }), false);
      assert.equal(isRetryableReason('cmc-handler-delivery-failed', { reason: 'refused' }), false);
      assert.equal(isRetryableReason('cmc-handler-delivery-failed', { peerReason: 'network' }), true);
    });
  });

  describe('[CRL0] 408 and 429 ask to come back later', () => {
    const { parseRetryAfter, retryAfterOf } = require('../src/outbound.ts');
    async function post (spec) {
      const { fetch } = fakeFetch(spec);
      return await postToPeer({ apiEndpoint: 'https://Tok@example.com/', path: 'events', body: {}, deps: { fetch } });
    }

    it('[CRL01] a 429 or a 408 is reason http-retry-later and retryable; every other 4xx stays http-4xx and permanent', async () => {
      for (const status of [408, 429]) {
        const r = await post({ status, body: { error: 'later' } });
        assert.equal(r.ok, false);
        assert.equal(r.reason, 'http-retry-later', String(status));
        assert.equal(r.status, status);
        assert.equal(isRetryableFailure(r), true, String(status));
        assert.equal('retryAfterMs' in r, false, 'no Retry-After header, no hint');
      }
      for (const status of [400, 401, 403, 404, 409, 410, 413, 422]) {
        const r = await post({ status, body: { error: 'no' } });
        assert.equal(r.reason, 'http-4xx', String(status));
        assert.equal(isRetryableFailure(r), false, String(status));
      }
    });

    it('[CRL02] the Retry-After header is read, in seconds or as an HTTP-date', async () => {
      const r = await post({ status: 429, body: {}, headers: { 'retry-after': '120' } });
      assert.equal(r.retryAfterMs, 120_000);
      assert.equal(retryAfterOf(r), 120_000);
      const at = new Date(Date.now() + 90_000).toUTCString();
      const d = await post({ status: 408, body: {}, headers: { 'retry-after': at } });
      assert.ok(d.retryAfterMs > 80_000 && d.retryAfterMs <= 90_000, String(d.retryAfterMs));
      const bad = await post({ status: 429, body: {}, headers: { 'retry-after': 'soon' } });
      assert.equal('retryAfterMs' in bad, false, 'an unreadable value is no hint');
      // A Retry-After on any other answer is not this classifier's business.
      const other = await post({ status: 503, body: {}, headers: { 'retry-after': '120' } });
      assert.equal(other.reason, 'http-5xx');
      assert.equal(retryAfterOf(other), undefined);
    });

    it('[CRL03] parseRetryAfter: seconds, dates (past reads as 0), garbage', () => {
      const now = Date.parse('2026-10-27T10:00:00Z');
      assert.equal(parseRetryAfter('0', now), 0);
      assert.equal(parseRetryAfter(' 30 ', now), 30_000);
      assert.equal(parseRetryAfter('Tue, 27 Oct 2026 10:01:00 GMT', now), 60_000);
      assert.equal(parseRetryAfter('Tue, 27 Oct 2026 09:00:00 GMT', now), 0);
      assert.equal(parseRetryAfter('Tue Oct 27 10:02:00 2026', now), 120_000, 'asctime form (no zone, means GMT whatever the local zone)');
      assert.equal(parseRetryAfter('Tue Oct  7 10:02:00 2026', Date.parse('2026-10-07T10:00:00Z')), 120_000, 'asctime form, one-digit day');
      assert.equal(parseRetryAfter('Tuesday, 27-Oct-26 10:03:00 GMT', now), 180_000, 'obsolete RFC 850 form');
      assert.equal(parseRetryAfter('-5', now), null);
      assert.equal(parseRetryAfter('later', now), null);
      assert.equal(parseRetryAfter('', now), null);
      assert.equal(parseRetryAfter(null, now), null);
    });

    it('[CRL04] the retry queue classifier agrees: http-retry-later is retryable in either detail field', () => {
      const { isRetryableReason } = require('../src/retryQueue.ts');
      assert.equal(isRetryableReason('cmc-handler-delivery-failed', { peerReason: 'http-retry-later' }), true);
      assert.equal(isRetryableReason('cmc-handler-delivery-failed', { reason: 'http-retry-later' }), true);
      assert.equal(isRetryableReason('cmc-handler-delivery-failed', { peerReason: 'http-4xx' }), false);
      // A reason that is permanent whatever the transport said stays so.
      assert.equal(isRetryableReason('cmc-handler-delivery-rejected', { reason: 'http-retry-later' }), false);
    });
  });
});
