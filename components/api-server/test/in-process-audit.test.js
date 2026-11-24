/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

import { createRequire } from 'node:module';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const require = createRequire(import.meta.url);
const __dirname = dirname(fileURLToPath(import.meta.url));

/* global initTests, initCore, coreRequest, getNewFixture, assert, cuid */

const fs = require('node:fs');
const path = require('node:path');

// API methods the server runs in-process, for a flow, leave the record the same
// call leaves over HTTP. The OAuth consent and the third-party sign-in have
// theirs in oauth2-registry-consent, oauth2-e2e and sso-e2e-seq.
describe('[IPAU] audit records of in-process API calls', function () {
  this.timeout(60_000);

  let fixtures, config, auditStorage, originalForUser, lossCounter;
  let username, token, accessId, personalToken;
  let rejections = [];
  const onRejection = (reason) => { rejections.push(reason); };

  before(async function () {
    await initTests();
    await initCore();
    fixtures = getNewFixture();
    config = await require('@pryv/boiler').getConfig();
    if (config.get('audit:active') !== true) this.skip();
    auditStorage = require('storages').auditStorage;
    originalForUser = auditStorage.forUser;
    lossCounter = require('audit/src/lossCounter.ts');
    username = 'ipau-' + cuid().slice(-8);
    const user = await fixtures.user(username);
    personalToken = cuid();
    await user.access({ token: personalToken, type: 'personal' });
    await user.session(personalToken);
    await user.stream({ id: 's', name: 's' });
    token = cuid();
    const access = await user.access({ token, type: 'app', name: 'ipau-app', permissions: [{ streamId: 's', level: 'manage' }] });
    accessId = access.attrs.id;
  });

  after(async function () {
    if (auditStorage != null) auditStorage.forUser = originalForUser;
    if (fixtures != null) {
      try { await fixtures.clean(); } catch (_e) { /* best-effort */ }
    }
  });

  beforeEach(function () {
    rejections = [];
    process.on('unhandledRejection', onRejection);
  });

  afterEach(function () {
    process.removeListener('unhandledRejection', onRejection);
    auditStorage.forUser = originalForUser;
  });

  async function rows (action) {
    const db = await originalForUser.call(auditStorage, username);
    const events = await db.getEvents({ query: [] });
    return events.filter((e) => e.content?.action === action);
  }

  /** The rows of `action` that `body` adds. */
  async function added (action, body) {
    const before = new Set((await rows(action)).map((e) => e.id));
    await body();
    return (await rows(action)).filter((e) => !before.has(e.id));
  }

  function deliver (params, { as = token, name = username } = {}) {
    const { localFirstFetch } = require('api-server/src/methods/helpers/localDelivery.ts');
    const network = [];
    const fetch = localFirstFetch(global.app.api, global.app.storageLayer, async (url) => { network.push(url); return Response.json({}, { status: 418 }); });
    const url = config.get('service:api').replace('{username}', name) + 'events';
    return fetch(url, { method: 'POST', headers: { authorization: as }, body: JSON.stringify(params) })
      .then(async (res) => ({ status: res.status, body: await res.json(), network }));
  }

  function handoff (as = token) {
    const { createHandoff } = require('api-server/src/routes/reg/credentialHandoff.ts');
    return createHandoff({ app: global.app, username, token: as, apiEndpoint: 'https://' + as + '@ipau.example.com/', requestingAppId: 'ipau', ttlSeconds: 60 });
  }

  const note = () => ({ streamIds: ['s'], type: 'note/txt', content: cuid() });

  it('[IPAU1] a delivery to an account of this core is recorded once, under the access it used, with no address', async function () {
    let res;
    const found = await added('events.create', async () => { res = await deliver(note()); });
    assert.strictEqual(res.status, 201, JSON.stringify(res.body));
    assert.ok(res.body.event?.id);
    assert.deepStrictEqual(res.network, []);
    assert.strictEqual(found.length, 1, JSON.stringify(found));
    assert.strictEqual(found[0].type, 'audit-log/pryv-api');
    assert.deepStrictEqual(found[0].content.source, { name: 'local-delivery' });
    assert.ok(found[0].streamIds.includes('access-' + accessId), JSON.stringify(found[0].streamIds));
    assert.ok(found[0].content.record?.integrity != null, 'the integrity reference of the created event');
  });

  it('[IPAU2] a refused delivery is recorded once as an error, its answer unchanged', async function () {
    let res;
    const found = await added('events.create', async () => { res = await deliver({ ...note(), streamIds: ['ipau-unknown'] }); });
    assert.strictEqual(res.status, 400, JSON.stringify(res.body));
    assert.strictEqual(res.body.error.id, 'unknown-referenced-resource');
    assert.strictEqual(found.length, 1, JSON.stringify(found));
    assert.strictEqual(found[0].type, 'audit-log/pryv-api-error');
    assert.strictEqual(found[0].content.id, 'unknown-referenced-resource');
  });

  it('[IPAU3] a delivery with a token that opens nothing is recorded; one to an unknown account goes to the network, no record', async function () {
    let res;
    const found = await added('events.create', async () => { res = await deliver(note(), { as: cuid() }); });
    assert.ok([401, 403].includes(res.status), JSON.stringify(res));
    assert.strictEqual(found.length, 1, JSON.stringify(found));
    assert.strictEqual(found[0].type, 'audit-log/pryv-api-error');
    assert.strictEqual(found[0].content.id, res.body.error.id);

    const none = await added('events.create', async () => { res = await deliver(note(), { name: 'ipau-nobody' }); });
    assert.strictEqual(res.status, 418);
    assert.strictEqual(res.network.length, 1);
    assert.deepStrictEqual(none, []);
  });

  it('[IPAU4] the one-time secret of a credential hand-off is recorded, without the token nor the key; its refusal too', async function () {
    let res;
    const found = await added('sharedSecrets.create', async () => { res = await handoff(); });
    assert.ok(res.handoff?.key, JSON.stringify(res));
    assert.strictEqual(found.length, 1, JSON.stringify(found));
    assert.strictEqual(found[0].type, 'audit-log/pryv-api');
    assert.deepStrictEqual(found[0].content.source, { name: 'credential-handoff' });
    assert.ok(found[0].streamIds.includes('access-' + accessId));
    const text = JSON.stringify(found[0]);
    assert.ok(!text.includes(token) && !text.includes(res.handoff.key), text);

    const unknown = await added('sharedSecrets.create', async () => { res = await handoff(cuid()); });
    assert.ok(res.fallback, JSON.stringify(res));
    assert.strictEqual(unknown.length, 1, JSON.stringify(unknown));
    assert.strictEqual(unknown[0].type, 'audit-log/pryv-api-error');

    const { injectTestConfigSnapshot } = require('test-helpers');
    const restore = injectTestConfigSnapshot({ sharedSecrets: { enabled: false } });
    try {
      const refused = await added('sharedSecrets.create', async () => { res = await handoff(); });
      assert.ok(res.fallback, JSON.stringify(res));
      assert.strictEqual(refused.length, 1, JSON.stringify(refused));
      assert.strictEqual(refused[0].type, 'audit-log/pryv-api-error');
    } finally {
      restore();
    }
  });

  it('[IPAU7] what a call left on the context does not show on the record of the next one', async function () {
    const { MethodContext } = require('business');
    const { callAudited } = require('api-server/src/methods/helpers/auditedCall.ts');
    const context = new MethodContext({ name: 'test', ip: null }, username, personalToken, null, {}, {}, null);
    await context.init();
    await context.retrieveExpandedAccess(global.app.storageLayer);
    await callAudited(global.app.api, context, 'events.create', note());
    // An unrecorded read in between, which leaves its count.
    context.methodId = 'events.get';
    await new Promise((resolve, reject) => {
      global.app.api.call(context, { limit: 1 }, (err, result) => err != null ? reject(err) : result.toObject((e) => e != null ? reject(e) : resolve()));
    });
    assert.ok(context.auditIntegrityPayload != null && context.auditRecordCount != null, 'the context carries both');
    const found = await added('streams.create', async () => {
      await callAudited(global.app.api, context, 'streams.create', { id: 'ipau7', name: 'ipau7' });
    });
    assert.strictEqual(found.length, 1);
    for (const key of ['record', 'recordCount', 'scopedStreamIds', 'scopedStreamCount']) {
      assert.strictEqual(found[0].content[key], undefined, key + ': ' + JSON.stringify(found[0].content));
    }
  });

  it('[IPAU8] a record that cannot be written changes nothing for the call, and is counted once', async function () {
    const before = lossCounter.snapshot().lost;
    auditStorage.forUser = async function (userId, ...rest) {
      if (userId !== username) return await originalForUser.call(auditStorage, userId, ...rest);
      return { createEvent: async () => { throw new Error('simulated audit storage failure'); } };
    };
    assert.strictEqual((await deliver(note())).status, 201);
    assert.strictEqual((await deliver({ ...note(), streamIds: ['ipau-unknown'] })).body.error.id, 'unknown-referenced-resource');
    assert.ok((await handoff()).handoff?.key);
    const now = lossCounter.snapshot().lost;
    assert.strictEqual(now.total - before.total, 3);
    assert.strictEqual(now.byKind.valid - before.byKind.valid, 2);
    assert.strictEqual(now.byKind.error - before.byKind.error, 1);
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.deepStrictEqual(rejections.map(String), []);
  });

  it('[IPAU9] in a batch, a call does not carry the integrity reference of an earlier create', async function () {
    let res;
    const found = await added('events.get', async () => {
      res = await coreRequest.post('/' + username).set('Authorization', personalToken).send([
        { method: 'events.create', params: note() },
        { method: 'events.get', params: { limit: 1 } }
      ]);
    });
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    assert.ok(res.body.results[0].event?.id);
    assert.strictEqual(found.length, 1);
    assert.strictEqual(found[0].content.record, undefined, JSON.stringify(found[0].content));
    assert.strictEqual(found[0].content.recordCount, 1);
  });

  it('[IPAU0] nothing else runs an API method in-process without a record', function () {
    // Outside these, `api.call` is given to `methodCallback`, whose HTTP answer
    // writes the record. Each file here records its calls itself, or says in a
    // comment what records them instead. (Sees the sources of the components
    // and receivers named after the API; not a dispatcher under another name.)
    const ALLOWED = {
      'api-server/src/methods/helpers/auditedCall.ts': 1,
      'api-server/src/methods/utility.ts': 1,
      'api-server/src/socket-io/Manager.ts': 1,
      'api-server/src/routes/externalIds.ts': 1,
      'api-server/src/routes/oauth2.ts': 1,
      'api-server/src/routes/sso.ts': 1
    };
    const root = path.resolve(__dirname, '../..');
    const found = {};
    function scan (dir) {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (entry.name !== 'node_modules') scan(full);
        } else if (entry.name.endsWith('.ts')) {
          const source = fs.readFileSync(full, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
          for (const match of source.matchAll(/\w*(?:api|API)\.call\(/g)) {
            // the call's own statement only
            if (/methodCallback\(/.test(source.slice(match.index).split(';')[0])) continue;
            const file = path.relative(root, full);
            found[file] = (found[file] ?? 0) + 1;
          }
        }
      }
    }
    for (const component of fs.readdirSync(root)) {
      const src = path.join(root, component, 'src');
      if (fs.existsSync(src)) scan(src);
    }
    assert.deepStrictEqual(found, ALLOWED);

    // What goes through the two unrecorded dispatchers.
    const read = (file) => fs.readFileSync(path.join(root, 'api-server/src/routes', file), 'utf8');
    const reads = [];
    for (const file of fs.readdirSync(path.join(root, 'api-server/src/routes/oauth2'))) {
      for (const [, args] of read('oauth2/' + file).matchAll(/apiRead\(([^)]*)/g)) reads.push(args.split(',')[1]?.trim());
    }
    assert.deepStrictEqual([...new Set(reads)].sort(), ["'accesses.get'", "'events.getOne'"]);
    assert.strictEqual(read('sso.ts').split('callUnrecorded(').length - 1, 1, 'one use (the definition has a space before its parenthesis)');
    assert.match(read('sso.ts'), /mintCtx\.methodId = 'auth\.ssoLogin';\n\s*const login = await callUnrecorded\(mintCtx,/);
  });
});
