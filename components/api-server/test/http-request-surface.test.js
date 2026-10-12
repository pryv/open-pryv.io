/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/* global initTests, initCore, coreRequest, getNewFixture, assert, cuid */

/**
 * Request surface of the HTTP routes: the id in the path is the one acted
 * on, and answers carry the cache directives their CORS echo and their
 * per-account content call for.
 */
describe('[HTRS] HTTP request surface', function () {
  let username, token, basePath, user;

  before(async function () {
    await initTests();
    await initCore();
    username = cuid();
    token = cuid();
    basePath = '/' + username;
    user = await getNewFixture().user(username, {});
    await user.access({ type: 'personal', token });
    await user.session(token);
  });

  describe('[HTR1] a query id never replaces the path id', function () {
    it('[HTP1] events: getOne and delete act on the path id', async function () {
      await user.stream({ id: 'htrs-s', name: 'htrs' });
      const a = (await user.event({ streamIds: ['htrs-s'], type: 'note/txt', content: 'a' })).attrs;
      const b = (await user.event({ streamIds: ['htrs-s'], type: 'note/txt', content: 'b' })).attrs;
      const got = await coreRequest.get(basePath + '/events/' + a.id).query({ id: b.id }).set('Authorization', token);
      assert.strictEqual(got.status, 200);
      assert.strictEqual(got.body.event.id, a.id);
      const del = await coreRequest.delete(basePath + '/events/' + a.id).query({ id: b.id }).set('Authorization', token);
      assert.strictEqual(del.status, 200);
      assert.strictEqual(del.body.event.id, a.id);
      assert.strictEqual(del.body.event.trashed, true);
      const other = await coreRequest.get(basePath + '/events/' + b.id).set('Authorization', token);
      assert.ok(other.body.event.trashed !== true, 'the query id was left alone');
    });

    it('[HTP2] streams: delete acts on the path id', async function () {
      await user.stream({ id: 'htrs-a', name: 'htrs a' });
      await user.stream({ id: 'htrs-b', name: 'htrs b' });
      const del = await coreRequest.delete(basePath + '/streams/htrs-a').query({ id: 'htrs-b' }).set('Authorization', token);
      assert.strictEqual(del.status, 200);
      assert.strictEqual(del.body.stream.id, 'htrs-a');
      assert.strictEqual(del.body.stream.trashed, true);
      const streams = await coreRequest.get(basePath + '/streams').set('Authorization', token);
      const b = streams.body.streams.find((s) => s.id === 'htrs-b');
      assert.ok(b != null && b.trashed !== true, 'the query id was left alone');
    });

    it('[HTP3] accesses: getOne and delete act on the path id', async function () {
      const a = (await user.access({ type: 'app', token: cuid(), name: 'htrs-a', permissions: [{ streamId: '*', level: 'read' }] })).attrs;
      const b = (await user.access({ type: 'app', token: cuid(), name: 'htrs-b', permissions: [{ streamId: '*', level: 'read' }] })).attrs;
      const got = await coreRequest.get(basePath + '/accesses/' + a.id).query({ id: b.id }).set('Authorization', token);
      assert.strictEqual(got.status, 200);
      assert.strictEqual(got.body.access.id, a.id);
      const del = await coreRequest.delete(basePath + '/accesses/' + a.id).query({ id: b.id }).set('Authorization', token);
      assert.strictEqual(del.status, 200);
      assert.strictEqual(del.body.accessDeletion.id, a.id);
      const remaining = await coreRequest.get(basePath + '/accesses').set('Authorization', token);
      assert.ok(remaining.body.accesses.some((x) => x.id === b.id), 'the query id was left alone');
    });
  });

  describe('[HTR2] cache directives', function () {
    const origin = 'https://htrs.example.com';

    it('[HTC1] a JSON answer varies by Origin and is not stored', async function () {
      const res = await coreRequest.get(basePath + '/events').set('Origin', origin).set('Authorization', token);
      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.headers['access-control-allow-origin'], origin);
      assert.ok(/\bOrigin\b/.test(res.headers.vary || ''), 'vary: ' + res.headers.vary);
      assert.strictEqual(res.headers['cache-control'], 'no-store');
    });

    it('[HTC2] a JSON error answer is not stored either', async function () {
      const res = await coreRequest.get(basePath + '/events').set('Origin', origin).set('Authorization', 'not-a-token');
      assert.ok(res.status >= 400);
      assert.ok(/application\/json/.test(res.headers['content-type']));
      assert.strictEqual(res.headers['cache-control'], 'no-store');
      assert.ok(/\bOrigin\b/.test(res.headers.vary || ''));
    });

    it('[HTC3] a preflight varies by Origin and by the requested method and headers', async function () {
      const res = await coreRequest.options(basePath + '/events')
        .set('Origin', origin)
        .set('Access-Control-Request-Method', 'POST')
        .set('Access-Control-Request-Headers', 'Content-Type');
      assert.strictEqual(res.status, 200);
      const vary = (res.headers.vary || '').split(',').map((v) => v.trim().toLowerCase());
      for (const name of ['origin', 'access-control-request-method', 'access-control-request-headers']) {
        assert.ok(vary.includes(name), name + ' in vary: ' + res.headers.vary);
      }
    });

    it('[HTC4] a non-JSON answer gets no cache directive from the API', async function () {
      const res = await coreRequest.get('/').set('Accept', 'text/html');
      assert.strictEqual(res.status, 200);
      assert.ok(/text\/html/.test(res.headers['content-type']));
      assert.strictEqual(res.headers['cache-control'], undefined);
    });
  });
});
