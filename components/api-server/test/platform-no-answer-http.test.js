/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

/**
 * [PNAH] A platform read that got no answer (a leader change) reaches the
 * client as 503 `api-unavailable` with the `Retry-After` header, on the
 * routes outside the method chain too: the routing check of `/{username}/*`,
 * a legacy `/reg` route, the admin `/reg/records` route.
 */

const assert = require('node:assert');
const { listeningAgent } = require('test-helpers');
const { getConfig } = require('@pryv/boiler');
const { getApplication } = require('api-server/src/application.ts');
const { platform } = require('platform');
const checkUserCore = require('middleware/src/checkUserCore.ts').default;

function noAnswer () {
  return Object.assign(new Error('rqlite query got no result at level linearizable: not leader'), { name: 'RqliteNoAnswerError' });
}

function assertNoAnswer503 (res) {
  assert.strictEqual(res.status, 503, JSON.stringify(res.body));
  assert.strictEqual(res.headers['retry-after'], '2');
  assert.strictEqual(res.body.error.id, 'api-unavailable');
  assert.ok(!JSON.stringify(res.body).includes('rqlite'), 'the engine text is not public');
}

describe('[PNAH] platform no-answer over HTTP', function () {
  let request;
  let adminKey;

  before(async function () {
    const config = await getConfig();
    adminKey = config.get('auth:adminAccessKey');
    const app = getApplication(true);
    await app.initiate();
    await platform.init();
    request = await listeningAgent(app.expressApp);
  });

  it('[PNAH1] the routing read of a /{username}/* request', async function () {
    checkUserCore._setPlatformForTests({
      isSingleCore: false,
      coreId: 'core-a',
      peekUserCoreForRouting: () => undefined,
      getUserCoreForRouting: async () => { throw noAnswer(); },
      coreIdToUrl: (id) => 'https://' + id + '.example.com/'
    });
    try {
      assertNoAnswer503(await request.get('/pnah-someone/access-info'));
    } finally {
      checkUserCore._resetPlatformCache();
    }
  });

  it('[PNAH2] a legacy /reg route', async function () {
    const original = platform.getUniqueValueOwner;
    platform.getUniqueValueOwner = async () => { throw noAnswer(); };
    try {
      assertNoAnswer503(await request.get('/reg/pnah2@example.com/username'));
    } finally {
      platform.getUniqueValueOwner = original;
    }
  });

  it('[PNAH3] the admin /reg/records route', async function () {
    const original = platform.getDnsRecord;
    platform.getDnsRecord = async () => { throw noAnswer(); };
    try {
      const res = await request.post('/reg/records').set('Authorization', adminKey)
        .send({ subdomain: 'pnah3', records: { a: ['192.0.2.7'] } });
      assertNoAnswer503(res);
      const del = await request.delete('/reg/records/pnah3').set('Authorization', adminKey);
      assertNoAnswer503(del);
    } finally {
      platform.getDnsRecord = original;
    }
  });
});
