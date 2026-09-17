/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/**
 * When the event-types dictionary has never loaded (the boot fetch failed), the
 * core runs degraded: it must REFUSE unknown event types rather than accept them
 * without content validation. When the dictionary is loaded, an unknown type is a
 * genuinely new free type and is accepted as before.
 *
 * Pattern C — initCore + coreRequest + getNewFixture + cuid.
 */

/* global initTests, initCore, coreRequest, getNewFixture, assert, cuid */

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

const { getEventTypesLoadState, _resetEventTypesLoadStateForTests, TypeRepository } = require('business').types;
const { getConfig } = require('@pryv/boiler');
const path = require('node:path');

// Repo-root-relative vendored snapshot, used to drive the recovery transition
// without hitting the network (same file the business unit suite uses).
const VENDORED_SOURCE_URL = 'file://' +
  path.resolve(import.meta.dirname, '../../../test/event-types-flat.json');

describe('[ETDG] event-types dictionary degraded fail-closed', function () {
  let username, token, streamId, eventsPath, adminKey;
  let user, fixtures;

  // A type that is not in any dictionary (embedded or published), so it is
  // "unknown" whether or not the dictionary loaded.
  const UNKNOWN_TYPE = 'zzz-degraded-test/custom';

  before(async function () {
    await initTests();
    await initCore();
    const config = await getConfig();
    adminKey = config.get('auth:adminAccessKey');
    // Pattern C's initCore registers only the user-facing API methods; the
    // system API is wired by the standalone server. Register it here so the
    // admin `/system/*` routes (mounted by initiateRoutes) resolve. Register on
    // `global.app` — the exact app instance coreRequest is bound to (helpers-base
    // sets `_global.app` and binds the server to its expressApp). Using the
    // module singleton (getApplication()) is unsafe: another test file may have
    // forced a new singleton, which would leave our methods on an app coreRequest
    // never reaches (a 404 that only shows up in a full-suite run).
    const app = global.app;
    await require('api-server/src/methods/system.ts').default(app.systemAPI, app.api);
    fixtures = getNewFixture();
    username = cuid();
    token = cuid();
    streamId = cuid();
    eventsPath = '/' + username + '/events';

    user = await fixtures.user(username);
    await user.stream({ id: streamId, name: 'degraded-test' });
    await user.access({ token, type: 'personal' });
    await user.session(token);
  });

  // The dictionary loaded at boot; always leave the global load state as loaded
  // so no sibling test file inherits a degraded core.
  afterEach(async function () {
    const repo = new TypeRepository();
    await repo.tryUpdate(VENDORED_SOURCE_URL);
    assert.strictEqual(getEventTypesLoadState().degraded, false);
  });

  async function createUnknown () {
    return coreRequest
      .post(eventsPath)
      .set('Authorization', token)
      .send({ streamIds: [streamId], type: UNKNOWN_TYPE, content: 'anything' });
  }

  it('[ETD1] accepts an unknown free type when the dictionary is loaded', async function () {
    assert.strictEqual(getEventTypesLoadState().degraded, false);
    const res = await createUnknown();
    assert.strictEqual(res.status, 201);
    assert.strictEqual(res.body?.event?.type, UNKNOWN_TYPE);
  });

  it('[ETD2] refuses an unknown type while the dictionary is degraded', async function () {
    _resetEventTypesLoadStateForTests();
    assert.strictEqual(getEventTypesLoadState().degraded, true);
    const res = await createUnknown();
    assert.strictEqual(res.status, 400);
    assert.strictEqual(res.body?.error?.id, 'invalid-operation');
    assert.strictEqual(res.body?.error?.data?.type, UNKNOWN_TYPE);
  });

  it('[ETD3] accepts the unknown type again once the dictionary recovers', async function () {
    _resetEventTypesLoadStateForTests();
    assert.strictEqual((await createUnknown()).status, 400);
    // recover
    const repo = new TypeRepository();
    await repo.tryUpdate(VENDORED_SOURCE_URL);
    const res = await createUnknown();
    assert.strictEqual(res.status, 201);
  });

  it('[ETD4] the admin status endpoint reports the dictionary load state', async function () {
    _resetEventTypesLoadStateForTests();
    const res = await coreRequest
      .get('/system/event-types-status')
      .set('Authorization', adminKey);
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body?.eventTypes?.degraded, true);
    assert.strictEqual(typeof res.body?.eventTypes?.embeddedVersion, 'string');
    // and it flips once loaded
    await new TypeRepository().tryUpdate(VENDORED_SOURCE_URL);
    const res2 = await coreRequest
      .get('/system/event-types-status')
      .set('Authorization', adminKey);
    assert.strictEqual(res2.body?.eventTypes?.degraded, false);
    assert.ok(typeof res2.body?.eventTypes?.lastSuccessAt === 'number');
  });
});
