/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/**
 * Shape assertions for fake collaborators used across cmc unit tests.
 *
 * Pins the cmc plugin's calling conventions to mall + outbound HTTP, so a
 * fake that previously accepted any param shape now rejects the wrong
 * shape at the call site. Catches the class of "wire-shape" bugs that
 * unit tests with permissive fakes would miss.
 */

const assert = require('node:assert/strict');

const ALLOWED_PATH_HEADS = new Set(['/events', '/streams', '/accesses']);

const ALLOWED_QUERY_PARAMS = new Set([
  'streams[]',
  'types[]',
  'limit',
  'fromTime',
  'toTime',
  'skip',
  'sortAscending',
]);

/**
 * Real mall.events.update signature is `events.update(userId, eventObject)`.
 * `eventObject` identifies the event by `id`; the OTHER fields are the new
 * values to write. A top-level `update` field is the WRONG shape (the HTTP
 * accesses.update API uses { id, update: {...} } — the mall does not).
 */
function assertEventUpdateShape (params) {
  assert.ok(params != null && typeof params === 'object',
    'mall.events.update: 2nd arg must be an event object; got ' + JSON.stringify(params));
  assert.ok(typeof params.id === 'string' && params.id.length > 0,
    'mall.events.update: 2nd arg must carry a string `id`; got keys ' +
    JSON.stringify(Object.keys(params)));
  assert.equal(params.update, undefined,
    'mall.events.update: 2nd arg must NOT have a top-level `update` field — ' +
    'pass event fields directly (not { id, update: {...} })');
}

/**
 * Validates the outbound URL grammar the cmc plugin uses to call peer Pryv
 * APIs. Pathname must be one of `/events`, `/streams`, `/accesses`, or
 * `/accesses/<id>`; query params must come from the Pryv API grammar
 * (`streams[]`, `types[]`, `limit`, …). Catches wire-shape mistakes
 * like `?streamIds=` instead of `?streams[]=`.
 */
function assertOutboundUrl (url, init) {
  let u;
  try { u = new URL(url); } catch (_e) {
    assert.fail('outbound fetch url is not a valid URL: ' + url);
  }
  const segments = u.pathname.split('/').filter((s) => s.length > 0);
  assert.ok(segments.length >= 1, 'outbound fetch path is empty: ' + u.pathname);
  const head = '/' + segments[0];
  assert.ok(ALLOWED_PATH_HEADS.has(head),
    'outbound fetch path not in whitelist: ' + u.pathname);
  if (head === '/accesses') {
    assert.ok(segments.length <= 2,
      'unexpected /accesses subpath depth: ' + u.pathname);
  } else {
    assert.equal(segments.length, 1,
      'unexpected subpath under ' + head + ': ' + u.pathname);
  }
  for (const k of u.searchParams.keys()) {
    assert.ok(ALLOWED_QUERY_PARAMS.has(k),
      'outbound fetch query param not in Pryv API whitelist: `' + k +
      '` (full url: ' + url + ')');
  }
  const method = (init && init.method ? init.method : 'GET').toUpperCase();
  if (method === 'POST' || method === 'PUT' || method === 'PATCH') {
    assert.ok(init != null && init.body != null,
      method + ' to ' + u.pathname + ' is missing a body');
  }
}

/**
 * `updateWithMerge` for a fake mall `events`: reads the fake's own store
 * (`getOne`, or a scan of `get` for a fake without it), applies the merge and
 * writes through the fake's `update`, so assertions on recorded updates and
 * per-test overrides of `update` keep working. Mirrors the real mall's
 * contract: a missing event throws, a null merge writes nothing and returns
 * null. Use as a method (`this` is the fake `events` the code under test
 * holds, including a spread copy with an overridden `update`):
 *   async updateWithMerge (...a) { return fakeUpdateWithMerge(this, ...a); }
 */
async function fakeUpdateWithMerge (events, userId, eventId, merge, transaction, opts) {
  const stored = events.getOne != null
    ? await events.getOne(userId, eventId)
    : ((await events.get?.(userId, {})) || []).find((e) => e?.id === eventId) ?? null;
  if (stored == null) throw Object.assign(new Error('Could not update event with id ' + eventId), { id: 'invalid-item-id' });
  const next = merge(structuredClone(stored));
  if (next == null) return null;
  return (await events.update(userId, { ...next, id: eventId }, transaction, opts)) ?? { ...next, id: eventId };
}

module.exports = { assertEventUpdateShape, assertOutboundUrl, fakeUpdateWithMerge };
