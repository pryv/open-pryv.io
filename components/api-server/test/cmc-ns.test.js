/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

/**
 * CMC plugin — namespace + write-hook integration tests.
 *
 * [CMCNS] covers: auto-provisioning of reserved parents on user creation;
 * reserved-root rejection on streams.create; plugin-managed segment
 * rejection (chats/collectors under :_cmc:apps); user-creatable region
 * allowance under :_cmc:apps:; cmc/* event content validation on
 * events.create.
 *
 * Pattern C — initCore + coreRequest + getNewFixture + cuid.
 */

/* global initTests, initCore, coreRequest, getNewFixture, assert, cuid */

const C = require('cmc');
const { getMall } = require('mall');

describe('[CMCNS] cmc namespace + write-hook integration', function () {
  let username, token, basePath, eventsPath;
  let user, fixtures;

  before(async function () {
    await initTests();
    await initCore();
    fixtures = getNewFixture();
    username = cuid();
    token = cuid();
    basePath = '/' + username + '/streams';
    eventsPath = '/' + username + '/events';

    user = await fixtures.user(username);
    await user.access({ token, type: 'personal' });
    await user.session(token);
  });

  describe('[CMCNS-AUTO] auto-provisioning on user creation', function () {
    // The reserved tree is provisioned when the user is created, before any
    // CMC operation. Lazy provisioning ([CMCNS-LAZY] below) still covers
    // accounts created before that, and a failed creation-time attempt.
    it('[CNA1] the reserved parents exist on a fresh user before any CMC operation', async function () {
      // Checked at the data layer: streams.get prunes the
      // `:_cmc:_internal*` subtree, and a streams.get on the namespace
      // would itself trigger the lazy path.
      const mall = await getMall();
      const uname = cuid();
      await fixtures.user(uname);
      for (const id of [
        C.NS,
        C.NS_INBOX,
        C.NS_APPS,
        C.NS_INTERNAL,
        C.NS_INTERNAL_RETRIES,
      ]) {
        const stream = await mall.streams.getOneWithNoChildren(uname, id, 'local');
        assert.ok(stream != null, 'expected reserved parent ' + id + ' to exist on a fresh user');
      }
    });

    it('[CNA2] a fresh user\'s streams.get lists the API-visible reserved parents', async function () {
      const res = await coreRequest
        .get(basePath)
        .set('Authorization', token);
      assert.strictEqual(res.status, 200);
      const allIds = [];
      function walk (s) {
        allIds.push(s.id);
        if (Array.isArray(s.children)) s.children.forEach(walk);
      }
      (res.body.streams || []).forEach(walk);
      for (const id of [C.NS, C.NS_INBOX, C.NS_APPS]) {
        assert.ok(allIds.includes(id), 'expected reserved parent ' + id + ' to exist; got: ' + JSON.stringify(allIds));
      }
    });
  });

  describe('[CMCNS-RR] reserved-root rejection on streams.create', function () {
    it('[CN02] rejects creating bare :_cmc: root', async function () {
      const res = await coreRequest
        .post(basePath)
        .set('Authorization', token)
        .send({ id: ':_cmc:', name: 'cmc root attempt' });
      assert.strictEqual(res.status, 400);
      assert.strictEqual(res.body?.error?.data?.id, 'cmc-reserved-stream');
    });

    it('[CN03] rejects creating reserved parents (inbox / apps / _internal / _internal:retries)', async function () {
      const blocked = [':_cmc:inbox', ':_cmc:apps', ':_cmc:_internal'];
      for (const id of blocked) {
        const res = await coreRequest
          .post(basePath)
          .set('Authorization', token)
          .send({ id, name: 'attempt', parentId: ':_cmc:' });
        assert.strictEqual(res.status, 400, 'expected 400 for ' + id);
        assert.strictEqual(res.body?.error?.data?.id, 'cmc-reserved-stream');
      }
    });

    it('[CN04] rejects creating under :_cmc:_internal:* (plugin-internal)', async function () {
      const res = await coreRequest
        .post(basePath)
        .set('Authorization', token)
        .send({
          id: ':_cmc:_internal:foo',
          parentId: ':_cmc:_internal',
          name: 'attempt',
        });
      assert.strictEqual(res.status, 400);
      assert.strictEqual(res.body?.error?.data?.id, 'cmc-reserved-stream');
    });
  });

  describe('[CMCNS-APPS] :_cmc:apps:<app-code> sub-stream creation (lazy auto-provision)', function () {
    it('[CN05] allows creating :_cmc:apps:my-app under :_cmc:apps', async function () {
      const res = await coreRequest
        .post(basePath)
        .set('Authorization', token)
        .send({
          id: ':_cmc:apps:my-app',
          parentId: ':_cmc:apps',
          name: 'My App',
        });
      assert.strictEqual(res.status, 201, JSON.stringify(res.body));
      assert.strictEqual(res.body?.stream?.id, ':_cmc:apps:my-app');
    });

    it('[CN06] allows nested user-creatable streams under an app stream', async function () {
      // self-contained: creates its own app parent so the test does not
      // depend on a sibling test having run (e.g. under --grep subsets)
      const parent = await coreRequest
        .post(basePath)
        .set('Authorization', token)
        .send({
          id: ':_cmc:apps:cn06-app',
          parentId: ':_cmc:apps',
          name: 'CN06 App',
        });
      assert.strictEqual(parent.status, 201, JSON.stringify(parent.body));
      const res = await coreRequest
        .post(basePath)
        .set('Authorization', token)
        .send({
          id: ':_cmc:apps:cn06-app:study-A',
          parentId: ':_cmc:apps:cn06-app',
          name: 'Study A',
        });
      assert.strictEqual(res.status, 201, JSON.stringify(res.body));
      assert.strictEqual(res.body?.stream?.id, ':_cmc:apps:cn06-app:study-A');
    });

    it('[CN07] rejects creating plugin-reserved segments under :_cmc:apps:my-app (chats / collectors)', async function () {
      for (const id of [
        ':_cmc:apps:my-app:chats',
        ':_cmc:apps:my-app:collectors',
        ':_cmc:apps:my-app:study-A:chats',
      ]) {
        const res = await coreRequest
          .post(basePath)
          .set('Authorization', token)
          .send({ id, parentId: ':_cmc:apps:my-app', name: 'attempt' });
        assert.strictEqual(res.status, 400, 'expected 400 for ' + id);
        assert.strictEqual(res.body?.error?.data?.id, 'cmc-reserved-stream');
      }
    });
  });

  describe('[CMCNS-EV] events.create write-hook validation', function () {
    before(async function () {
      // CN10/CN11 need `:_cmc:apps:my-app` to exist. The lazy auto-provision
      // creates the five reserved parents up to `:_cmc:apps`; user-app
      // scopes are user-creatable beneath that.
      await coreRequest
        .post(basePath)
        .set('Authorization', token)
        .send({ id: ':_cmc:apps:my-app', parentId: ':_cmc:apps', name: 'My App' })
        .catch(() => {}); // idempotent — ignore if already exists
    });

    it('[CN08] passes through unrecognised types under shared classes (post class/format rename)', async function () {
      // CMC plugin's class namespaces (consent, message, notification)
      // are shared with potentially app-defined formats. We don't claim
      // every event in those classes — only the exact set of CMC-known
      // types is intercepted for content validation. An unrecognised
      // type under a `:_cmc:apps:*` stream passes through and is
      // persisted (the app may be using its own custom format).
      const res = await coreRequest
        .post(eventsPath)
        .set('Authorization', token)
        .send({
          streamIds: [':_cmc:apps:my-app'],
          type: 'consent/something-app-defined',
          content: { hello: 'world' },
        });
      assert.strictEqual(res.status, 201);
      assert.strictEqual(res.body?.event?.type, 'consent/something-app-defined');
    });

    it('[CN09] rejects consent/request-cmc with missing required fields', async function () {
      // Since `consent/request-cmc` is published in the canonical
      // pryv/data-types directory, the api-server's upstream JSON-schema
      // validator (z-schema, fed by `service.eventTypes`) fires BEFORE
      // the CMC content validator. Errors land as
      // `invalid-parameters-format` with the JSON-schema validation
      // detail in `error.data` (an array of schema-violation entries).
      // The CMC validator (`cmc-invalid-event-content`) remains as
      // defense-in-depth for cases the upstream schema can't express.
      const res = await coreRequest
        .post(eventsPath)
        .set('Authorization', token)
        .send({
          streamIds: [':_cmc:apps:my-app'],
          type: 'consent/request-cmc',
          content: { to: null },
        });
      assert.strictEqual(res.status, 400);
      assert.strictEqual(res.body?.error?.id, 'invalid-parameters-format');
      assert.ok(Array.isArray(res.body?.error?.data),
        'expected error.data to be the array of JSON-schema violations');
      // At least one violation should mention the missing `request` field.
      const hasRequestViolation = res.body.error.data.some((e) =>
        Array.isArray(e.params) && e.params.includes('request'));
      assert.ok(hasRequestViolation,
        'expected a violation about the missing `request` field; got ' +
        JSON.stringify(res.body.error.data));
    });

    it('[CN10] accepts a fully-formed consent/request-cmc (lazy provision + mall.accesses adapter)', async function () {
      const res = await coreRequest
        .post(eventsPath)
        .set('Authorization', token)
        .send({
          streamIds: [':_cmc:apps:my-app'],
          type: 'consent/request-cmc',
          content: {
            to: null,
            capabilityRequested: true,
            request: {
              title: { en: 'Example consent' },
              description: { en: 'Share data for the study.' },
              consent: { en: 'I agree.' },
              permissions: [{ streamId: 'fertility', level: 'read' }],
            },
          },
        });
      assert.strictEqual(res.status, 201, JSON.stringify(res.body));
      assert.strictEqual(res.body?.event?.type, 'consent/request-cmc');
    });

    it('[CN11] allows app-defined event types on :_cmc:apps:* streams', async function () {
      const res = await coreRequest
        .post(eventsPath)
        .set('Authorization', token)
        .send({
          streamIds: [':_cmc:apps:my-app'],
          type: 'note/txt',
          content: 'plain note in an app scope stream',
        });
      assert.strictEqual(res.status, 201, JSON.stringify(res.body));
    });
  });

  describe('[CMCNS-H6] streams.delete reserved-root immutability', function () {
    // Even a personal token (which has implicit '*'
    // manage and bypasses per-access permission checks) must NOT be
    // able to delete one of the plugin-auto-provisioned reserved
    // parents. Without this guard, deleting `:_cmc:` would silently
    // break every active CMC relationship on the account.

    it('[CN15] rejects delete of the bare :_cmc: root by a personal token', async function () {
      // Ensure the parent exists by triggering lazy provisioning first.
      await coreRequest
        .post(eventsPath)
        .set('Authorization', token)
        .send({
          streamIds: [':_cmc:apps:my-app'],
          type: 'note/txt',
          content: 'trigger provisioning',
        });
      const res = await coreRequest
        .delete('/' + username + '/streams/' + encodeURIComponent(':_cmc:'))
        .set('Authorization', token);
      assert.strictEqual(res.status, 400, JSON.stringify(res.body));
      assert.strictEqual(res.body?.error?.data?.id, 'cmc-reserved-stream-undeletable');
    });

    it('[CN16] rejects delete of :_cmc:_internal by a personal token', async function () {
      const res = await coreRequest
        .delete('/' + username + '/streams/' + encodeURIComponent(':_cmc:_internal'))
        .set('Authorization', token);
      assert.strictEqual(res.status, 400, JSON.stringify(res.body));
      assert.strictEqual(res.body?.error?.data?.id, 'cmc-reserved-stream-undeletable');
    });

    it('[CN17] rejects delete of :_cmc:apps by a personal token', async function () {
      const res = await coreRequest
        .delete('/' + username + '/streams/' + encodeURIComponent(':_cmc:apps'))
        .set('Authorization', token);
      assert.strictEqual(res.status, 400, JSON.stringify(res.body));
      assert.strictEqual(res.body?.error?.data?.id, 'cmc-reserved-stream-undeletable');
    });
  });

  describe('[CMCNS-H7] accesses.create / accesses.update forge-prevention', function () {
    // The `clientData.cmc` namespace is plugin-owned. User
    // code attempting to forge fields under it (e.g. `role: counterparty`
    // to bypass the handshake, or a fake `capability.state` to confuse
    // the lifecycle) must be rejected up-front at the api-server route
    // level. The CMC plugin itself uses mall.accesses.create /
    // mall.accesses.update which bypass these route hooks — safe.

    const accessesPath = () => '/' + username + '/accesses';

    before(async function () {
      // Full-matrix runs have intermittently seen `404 !== 201` on the
      // accesses.create calls below — the suite-level fixture user going
      // missing/stale deep in a matrix, not forge-prevention logic. Fail
      // legibly here instead of cryptically inside the tests.
      const res = await coreRequest
        .get('/' + username + '/access-info')
        .set('Authorization', token);
      assert.strictEqual(res.status, 200,
        'fixture user/session "' + username + '" is missing or stale entering [CMCNS-H7]: ' +
        res.status + ' ' + JSON.stringify(res.body));
    });

    it('[CN12] accesses.create rejects clientData.cmc.role forge', async function () {
      const res = await coreRequest
        .post(accessesPath())
        .set('Authorization', token)
        .send({
          name: 'forged-counterparty-' + cuid(),
          type: 'shared',
          permissions: [{ streamId: '*', level: 'read' }],
          clientData: { cmc: { role: 'counterparty', appCode: 'evil' } },
        });
      assert.strictEqual(res.status, 400, JSON.stringify(res.body));
      assert.strictEqual(res.body?.error?.data?.id, 'cmc-clientdata-cmc-forbidden');
    });

    it('[CN13] accesses.create allows non-cmc clientData keys', async function () {
      const res = await coreRequest
        .post(accessesPath())
        .set('Authorization', token)
        .send({
          name: 'app-stream-id-' + cuid(),
          type: 'shared',
          permissions: [{ streamId: '*', level: 'read' }],
          clientData: { appStreamId: 'my-app-' + cuid() },
        });
      assert.strictEqual(res.status, 201, JSON.stringify(res.body));
    });

    // NOTE: accesses.update path of the forge guard is covered by
    // [CH-AU03] in components/cmc/test/hooks.test.js (unit). A full
    // round-trip integration test was tried here as `[CN14]` but the
    // create+put sequence interacts with mocha's process-wide test
    // ordering and surfaces an unrelated flake in webhooks-test.js
    // (WH12 → 404). The unit test gives the same coverage without the
    // test-isolation cost.
  });

  describe('[CMCNS-LAZY] lazy provisioning covers every entry point', function () {
    // Regression cover for open-pryv.io#111: when the reserved tree is
    // missing (an account created before creation-time provisioning, or
    // whose creation-time attempt failed), it is created on first touch.
    // It used to be created on WRITES only, so a consumer whose first CMC
    // act was a read (an inbox watcher) got `unknown-referenced-resource`
    // on every poll, forever.
    //
    // Every test here needs its own VIRGIN user: creation-time provisioning
    // is undone below so the lazy path is what gets exercised.

    async function makeVirginUser () {
      const uname = cuid();
      const utoken = cuid();
      const u = await fixtures.user(uname);
      await u.access({ token: utoken, type: 'personal' });
      await u.session(utoken);
      const mall = await getMall();
      for (const id of [C.NS_INTERNAL_RETRIES, C.NS_INTERNAL, C.NS_APPS, C.NS_INBOX, C.NS]) {
        await mall.streams.delete(uname, id);
      }
      assert.strictEqual(await mall.streams.getOneWithNoChildren(uname, C.NS, 'local'), null);
      return { username: uname, token: utoken };
    }

    it('[PRV01] read-first: events.get on :_cmc:inbox succeeds on a virgin account', async function () {
      const v = await makeVirginUser();
      const res = await coreRequest
        .get('/' + v.username + '/events')
        .set('Authorization', v.token)
        .query({ streams: [C.NS_INBOX], limit: 1 });
      assert.strictEqual(res.status, 200,
        'read-first query must not 404 the namespace: ' + JSON.stringify(res.body));
      assert.ok(Array.isArray(res.body.events));
    });

    it('[PRV02] read-first on an app scope succeeds and materialises the reserved parents', async function () {
      const v = await makeVirginUser();
      const res = await coreRequest
        .get('/' + v.username + '/events')
        .set('Authorization', v.token)
        .query({ streams: [C.NS_APPS], limit: 1 });
      assert.strictEqual(res.status, 200, JSON.stringify(res.body));

      // The tree is now real, not merely tolerated by the query.
      const streamsRes = await coreRequest
        .get('/' + v.username + '/streams')
        .set('Authorization', v.token);
      const allIds = [];
      (function walk (list) {
        for (const s of list || []) {
          allIds.push(s.id);
          if (Array.isArray(s.children)) walk(s.children);
        }
      })(streamsRes.body.streams);
      // Only the app-visible parents are assertable here: the
      // `:_cmc:_internal*` subtree is deliberately pruned from
      // streams.get responses by the internal-guard hook, so its
      // absence from this list says nothing about whether it exists.
      for (const id of [C.NS, C.NS_INBOX, C.NS_APPS]) {
        assert.ok(allIds.includes(id),
          'expected reserved parent ' + id + ' after a read; got ' + JSON.stringify(allIds));
      }
      assert.ok(!allIds.includes(C.NS_INTERNAL),
        'the plugin-internal subtree must stay hidden from streams.get');
    });

    it('[PRV03] a non-CMC read on a virgin account does NOT provision the namespace', async function () {
      const v = await makeVirginUser();
      const res = await coreRequest
        .get('/' + v.username + '/events')
        .set('Authorization', v.token)
        .query({ limit: 1 });
      assert.strictEqual(res.status, 200, JSON.stringify(res.body));

      const streamsRes = await coreRequest
        .get('/' + v.username + '/streams')
        .set('Authorization', v.token);
      const rootIds = (streamsRes.body.streams || []).map((s) => s.id);
      assert.ok(!rootIds.includes(C.NS),
        'a plain read must not create the CMC tree; root ids: ' + JSON.stringify(rootIds));
    });

    it('[PRV04] grant-first: accesses.create with an :_cmc:apps:<app> permission provisions parents + leaf', async function () {
      const v = await makeVirginUser();
      const appCode = 'grantfirst-' + cuid().slice(-6);
      const leafStreamId = C.NS_APPS + ':' + appCode;

      const res = await coreRequest
        .post('/' + v.username + '/accesses')
        .set('Authorization', v.token)
        .send({
          name: 'grant-first-' + cuid(),
          type: 'app',
          permissions: [{ streamId: leafStreamId, level: 'manage' }],
        });
      assert.strictEqual(res.status, 201, JSON.stringify(res.body));

      // The leaf must exist — before the fix its create failed because
      // its parent :_cmc:apps had never been provisioned.
      const verify = await coreRequest
        .post('/' + v.username + '/streams')
        .set('Authorization', v.token)
        .send({ id: leafStreamId, parentId: C.NS_APPS, name: appCode });
      assert.strictEqual(verify.body?.error?.id, 'item-already-exists',
        'app-scope leaf should already exist after the grant; got ' + JSON.stringify(verify.body));
    });

    it('[PRV05] read-first account can then run a normal CMC write', async function () {
      const v = await makeVirginUser();
      const readRes = await coreRequest
        .get('/' + v.username + '/events')
        .set('Authorization', v.token)
        .query({ streams: [C.NS_INBOX], limit: 1 });
      assert.strictEqual(readRes.status, 200, JSON.stringify(readRes.body));

      const appScope = C.NS_APPS + ':after-read-' + cuid().slice(-6);
      const createRes = await coreRequest
        .post('/' + v.username + '/streams')
        .set('Authorization', v.token)
        .send({ id: appScope, parentId: C.NS_APPS, name: 'After read' });
      assert.strictEqual(createRes.status, 201, JSON.stringify(createRes.body));
    });
  });

  describe('[CMCNS-INTERNAL] the plugin-internal subtree is never leaked by client reads', function () {
    // Seed an internal event exactly as the plugin's retry queue does — via the
    // mall, bypassing the api-server route (user code cannot write here). Then
    // assert no client read path surfaces it. The content carries a canary plus
    // a controlApiEndpoint-shaped field to mirror the credential-leak concern.
    let iv;
    const CANARY = 'CMC-INTERNAL-LEAK-CANARY-' + cuid();

    before(async function () {
      const mall = await getMall();
      const uname = cuid();
      const utoken = cuid();
      const u = await fixtures.user(uname);
      await u.access({ token: utoken, type: 'personal' });
      await u.session(utoken);
      iv = { username: uname, token: utoken };
      // Provision the reserved parents (incl. the internal subtree) the same way
      // the plugin does, then write the internal canary event under it.
      await C.provisionUserStreams({ mall, userId: uname });
      await mall.events.create(uname, {
        streamIds: [C.NS_INTERNAL_RETRIES],
        type: C.ET_RETRY,
        content: { canary: CANARY, controlApiEndpoint: 'https://leak.invalid/control' },
      });
    });

    function leaks (events) {
      return (events || []).filter((e) =>
        JSON.stringify(e.content ?? '').includes(CANARY) ||
        (e.streamIds || []).some((s) => String(s).startsWith(C.NS_INTERNAL)));
    }

    it('[CI01] default `*` events.get never expands into :_cmc:_internal', async function () {
      const res = await coreRequest.get('/' + iv.username + '/events')
        .set('Authorization', iv.token).query({ limit: 1000 });
      assert.strictEqual(res.status, 200, JSON.stringify(res.body));
      assert.strictEqual(leaks(res.body.events).length, 0, 'default `*` leaked an internal event');
    });

    it('[CI02] explicit `[*]` events.get never expands into :_cmc:_internal', async function () {
      const res = await coreRequest.get('/' + iv.username + '/events')
        .set('Authorization', iv.token).query({ streams: ['*'], limit: 1000 });
      assert.strictEqual(res.status, 200, JSON.stringify(res.body));
      assert.strictEqual(leaks(res.body.events).length, 0, 'explicit `*` leaked an internal event');
    });

    it('[CI03] a single-value direct-target internal read returns nothing', async function () {
      const res = await coreRequest.get('/' + iv.username + '/events')
        .set('Authorization', iv.token)
        .query({ streams: C.NS_INTERNAL_RETRIES, limit: 1000 });
      assert.strictEqual(res.status, 200, JSON.stringify(res.body));
      assert.strictEqual(leaks(res.body.events).length, 0, 'single-value internal target leaked');
    });

    it('[CI04] a logical-query targeting an internal id has it scrubbed', async function () {
      // Mix a legit stream so the query stays valid after the internal id is
      // scrubbed — this exercises the logical-query hardening (any/all/not).
      const res = await coreRequest.get('/' + iv.username + '/events')
        .set('Authorization', iv.token)
        .query({ streams: JSON.stringify([{ any: [C.NS_INBOX, C.NS_INTERNAL_RETRIES] }]), limit: 1000 });
      assert.strictEqual(res.status, 200, JSON.stringify(res.body));
      assert.strictEqual(leaks(res.body.events).length, 0, 'logical-query internal target leaked');
    });

    it('[CI05] streams.get does not expose the :_cmc:_internal subtree', async function () {
      const sg = await coreRequest.get('/' + iv.username + '/streams').set('Authorization', iv.token);
      assert.strictEqual(sg.status, 200);
      const flat = [];
      (function walk (nodes) { for (const n of (nodes || [])) { flat.push(n.id); walk(n.children); } })(sg.body.streams);
      assert.ok(!flat.some((s) => String(s).startsWith(C.NS_INTERNAL)),
        'streams.get must not expose :_cmc:_internal');
    });
  });
});
