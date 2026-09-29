/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

const assert = require('node:assert/strict');

const { Platform } = require('../../src/Platform.ts');

/**
 * Hosted-site names are reserved usernames on every core: this core's own
 * `hostedSites` keys and the `sites` advertised by any core-info row. Runs the
 * real Platform code against an in-memory PlatformDB fake.
 */

function makeConfig (values) {
  return { get: (key) => values[key] };
}

function makeFakeDb ({ coreInfos = [], invitation = 'tok' } = {}) {
  const rows = new Map(coreInfos.map((c) => [c.id, c]));
  return {
    rows,
    async getAllCoreInfos () { return [...rows.values()].map((r) => JSON.parse(JSON.stringify(r))); },
    async setCoreInfo (id, info) { rows.set(id, JSON.parse(JSON.stringify(info))); },
    // a live token keeps #checkInvitationToken off the config fallback
    async getAllInvitationTokens () { return [{ id: 'h' }]; },
    async getInvitationToken () { return { description: invitation }; }
  };
}

function makePlatform ({ config = {}, coreInfos } = {}) {
  const platform = new Platform();
  const db = makeFakeDb({ coreInfos });
  platform._setDependenciesForTests(db, null, makeConfig(Object.assign({ 'core:id': 'core-a' }, config)));
  return { platform, db };
}

async function assertRegistrationRefused (platform, username) {
  await assert.rejects(
    () => platform.validateRegistration(username, 'tok', { username }, null),
    (err) => err.id === 'item-already-exists' && err.data != null && err.data.username === username
  );
}

describe('[PLHS] hosted-site names are reserved usernames', () => {
  it('[PLH1] a name from this core\'s hostedSites is refused at registration and at change-username', async () => {
    // not `account`: that one is already in the reserved-words dictionary
    const { platform } = makePlatform({ config: { hostedSites: { sitehome: { static: '/srv/a' } } } });
    await assertRegistrationRefused(platform, 'sitehome');
    await assertRegistrationRefused(platform, 'SITEHOME');
    // the change-username flow asks the same question
    assert.equal(platform.isUsernameReserved('sitehome'), true);
  });

  it('[PLH2] a name advertised only by another core\'s info row is refused too', async () => {
    const { platform } = makePlatform({ coreInfos: [{ id: 'core-b', ip: '10.0.0.2', sites: ['sitedocs'] }] });
    assert.equal(platform.isUsernameReserved('sitedocs'), false, 'not known before any core-info read');
    await assertRegistrationRefused(platform, 'sitedocs');
    assert.equal(platform.isUsernameReserved('sitedocs'), true);
  });

  it('[PLH3] a site added on another core after boot is seen by refreshHostedSiteNames', async () => {
    const { platform, db } = makePlatform({ coreInfos: [{ id: 'core-b', ip: '10.0.0.2' }] });
    await platform.refreshHostedSiteNames();
    assert.equal(platform.isUsernameReserved('latesite'), false);
    db.rows.set('core-b', { id: 'core-b', ip: '10.0.0.2', sites: ['latesite'] });
    await platform.refreshHostedSiteNames();
    assert.equal(platform.isUsernameReserved('latesite'), true);
    // ordinary names stay free
    assert.equal(platform.isUsernameReserved('someuser'), false);
  });

  it('[PLH4] registerSelf advertises the sorted site names and the snapshot carries them', async () => {
    const { platform, db } = makePlatform({ config: { hostedSites: { zsite: { static: '/srv/z' }, account: { proxy: 'https://e.org/' } } } });
    await platform.registerSelf();
    assert.deepEqual(db.rows.get('core-a').sites, ['account', 'zsite']);
    assert.deepEqual(platform.getPlatformConfigSnapshot().snapshot['hostedSites.names'], ['account', 'zsite']);
  });

  it('[PLH5] without hosted sites the core-info row and the snapshot are unchanged', async () => {
    const { platform, db } = makePlatform();
    await platform.registerSelf();
    assert.equal('sites' in db.rows.get('core-a'), false);
    assert.equal('hostedSites.names' in platform.getPlatformConfigSnapshot().snapshot, false);
  });
});
