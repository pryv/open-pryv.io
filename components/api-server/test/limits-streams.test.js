/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
/* global initTests, initCore, coreRequest, getNewFixture, assert, cuid */

/**
 * [STLM] Bounds on an account's stream tree (limits.streams.maxDepth,
 * limits.streams.maxPerAccount) and on an event's stream list
 * (limits.events.maxStreamIds). A cap refuses the write that would pass it;
 * what is already stored stays readable.
 */

const { withInjectedConfig } = require('test-helpers');
const { ErrorIds } = require('errors/src/index.ts');
const { readStreamLimits, measureTree, STREAM_LIMIT_DEFAULTS } = require('../src/methods/helpers/streamLimits.ts');

describe('[STLM] stream tree and stream list limits', function () {
  let fixtures, username, token;

  before(async function () {
    await initTests();
    await initCore();
    fixtures = getNewFixture();
  });

  beforeEach(async function () {
    username = cuid();
    token = cuid();
    const user = await fixtures.user(username, {});
    await user.access({ type: 'personal', token });
    await user.session(token);
  });

  afterEach(async function () {
    await fixtures.clean();
  });

  function createStream (id, parentId) {
    return coreRequest.post('/' + username + '/streams').set('Authorization', token)
      .send({ id, name: 'stlm-' + id, parentId });
  }

  async function chain (ids, parentId = null) {
    for (const id of ids) {
      const res = await createStream(id, parentId);
      assert.strictEqual(res.status, 201, id + ': ' + JSON.stringify(res.body));
      parentId = id;
    }
  }

  it('[STLM1] a stream below limits.streams.maxDepth is refused on creation; 0 disables the check', async function () {
    await withInjectedConfig({ limits: { streams: { maxDepth: 3 } } }, async () => {
      await chain(['a-' + username, 'b-' + username, 'c-' + username]);
      const refused = await createStream('d-' + username, 'c-' + username);
      assert.strictEqual(refused.status, 400, JSON.stringify(refused.body));
      assert.strictEqual(refused.body.error.id, ErrorIds.InvalidOperation);
      assert.match(refused.body.error.message, /limits\.streams\.maxDepth/);
      const sibling = await createStream('e-' + username, 'b-' + username);
      assert.strictEqual(sibling.status, 201, JSON.stringify(sibling.body));
    });
    await withInjectedConfig({ limits: { streams: { maxDepth: 0 } } }, async () => {
      const accepted = await createStream('d-' + username, 'c-' + username);
      assert.strictEqual(accepted.status, 201, JSON.stringify(accepted.body));
    });
  });

  it('[STLM2] a move is refused when the moved subtree would pass limits.streams.maxDepth', async function () {
    await withInjectedConfig({ limits: { streams: { maxDepth: 3 } } }, async () => {
      const [x, y, r, s] = ['x', 'y', 'r', 's'].map((n) => n + '-' + username);
      await chain([x, y]);
      await chain([r, s]);
      const tooDeep = await coreRequest.put('/' + username + '/streams/' + x).set('Authorization', token).send({ parentId: s });
      assert.strictEqual(tooDeep.status, 400, JSON.stringify(tooDeep.body));
      assert.strictEqual(tooDeep.body.error.id, ErrorIds.InvalidOperation);
      const fits = await coreRequest.put('/' + username + '/streams/' + x).set('Authorization', token).send({ parentId: r });
      assert.strictEqual(fits.status, 200, JSON.stringify(fits.body));
      // A rename does not move anything.
      const rename = await coreRequest.put('/' + username + '/streams/' + y).set('Authorization', token).send({ name: 'renamed-' + y });
      assert.strictEqual(rename.status, 200, JSON.stringify(rename.body));
    });
  });

  it('[STLM3] creation past limits.streams.maxPerAccount is refused; the streams already there stay readable', async function () {
    // The account's count includes streams the API does not list (plugin
    // internals): read it from a refusal.
    let existing;
    await withInjectedConfig({ limits: { streams: { maxPerAccount: 1 } } }, async () => {
      const probe = await createStream('p0-' + username, null);
      assert.strictEqual(probe.status, 400, JSON.stringify(probe.body));
      existing = Number(/already holds (\d+) streams/.exec(probe.body.error.message)?.[1]);
    });
    assert.ok(existing >= 1, 'count read from the refusal');
    await withInjectedConfig({ limits: { streams: { maxPerAccount: existing + 2 } } }, async () => {
      assert.strictEqual((await createStream('p1-' + username, null)).status, 201);
      assert.strictEqual((await createStream('p2-' + username, null)).status, 201);
      const refused = await createStream('p3-' + username, null);
      assert.strictEqual(refused.status, 400, JSON.stringify(refused.body));
      assert.strictEqual(refused.body.error.id, ErrorIds.InvalidOperation);
      assert.match(refused.body.error.message, /limits\.streams\.maxPerAccount/);
      const read = await coreRequest.get('/' + username + '/streams').set('Authorization', token);
      assert.strictEqual(read.status, 200, JSON.stringify(read.body));
    });
  });

  it('[STLM4] an event with more distinct streamIds than limits.events.maxStreamIds is refused; duplicates count once', async function () {
    const ids = ['s1', 's2', 's3'].map((n) => n + '-' + username);
    for (const id of ids) assert.strictEqual((await createStream(id, null)).status, 201);
    await withInjectedConfig({ limits: { events: { maxStreamIds: 2 } } }, async () => {
      const refused = await coreRequest.post('/' + username + '/events').set('Authorization', token)
        .send({ streamIds: ids, type: 'note/txt', content: 'stlm' });
      assert.strictEqual(refused.status, 400, JSON.stringify(refused.body));
      assert.strictEqual(refused.body.error.id, ErrorIds.InvalidParametersFormat);
      const deduplicated = await coreRequest.post('/' + username + '/events').set('Authorization', token)
        .send({ streamIds: [ids[0], ids[1], ids[0]], type: 'note/txt', content: 'stlm' });
      assert.strictEqual(deduplicated.status, 201, JSON.stringify(deduplicated.body));
      const update = await coreRequest.put('/' + username + '/events/' + deduplicated.body.event.id).set('Authorization', token)
        .send({ streamIds: ids });
      assert.strictEqual(update.status, 400, JSON.stringify(update.body));
      assert.strictEqual(update.body.error.id, ErrorIds.InvalidParametersFormat);
    });
  });

  it('[STLM5] defaults apply when the config is absent or invalid; the tree walk does not recurse', function () {
    assert.deepStrictEqual(readStreamLimits(() => undefined), { ...STREAM_LIMIT_DEFAULTS });
    assert.deepStrictEqual(readStreamLimits(() => -1), { ...STREAM_LIMIT_DEFAULTS });
    assert.deepStrictEqual(readStreamLimits(() => 0), { maxDepth: 0, maxPerAccount: 0, maxStreamIds: 0 });
    let deep = { id: 'leaf' };
    for (let i = 0; i < 100000; i++) deep = { id: 'n' + i, children: [deep] };
    const measured = measureTree([deep], 'leaf');
    assert.deepStrictEqual(measured, { count: 100001, levelOf: 100001, height: 100001 });
  });
});
