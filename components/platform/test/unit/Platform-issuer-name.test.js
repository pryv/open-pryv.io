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
 * An OAuth issuer host `<label>.<dns.domain>` is a name the platform answers
 * (it points at this core), so its label is never a username. Runs the real
 * Platform code against an in-memory PlatformDB fake.
 */

function makePlatform (config) {
  const values = Object.assign({ 'core:id': 'core-a', 'dns:domain': 'example.com' }, config);
  const db = {
    async getAllCoreInfos () { return [{ id: 'core-a' }]; },
    async getAllDnsRecords () { return []; },
    // a live token keeps #checkInvitationToken off the config fallback
    async getAllInvitationTokens () { return [{ id: 'h' }]; },
    async getInvitationToken () { return { description: 'tok' }; }
  };
  const platform = new Platform();
  platform._setDependenciesForTests(db, null, { get: (key) => values[key] });
  return platform;
}

describe('[PLIS] the OAuth issuer label is a reserved username', () => {
  it('[PLIS1] an issuer under dns.domain: its label is refused at registration and routing-reserved', async () => {
    const platform = makePlatform({ 'oauth:issuer': 'https://Auth-EU.example.com/' });
    assert.equal(platform.isUsernameRoutingReserved('auth-eu'), false, 'not known before a names read');
    await assert.rejects(
      () => platform.validateRegistration('auth-eu', 'tok', { username: 'auth-eu' }, null),
      (err) => err.id === 'item-already-exists' && err.data?.username === 'auth-eu'
    );
    assert.equal(platform.isUsernameRoutingReserved('auth-eu'), true);
    assert.equal(platform.isUsernameRoutingReserved('AUTH-EU'), true);
    assert.equal(platform.isUsernameReserved('auth-eu'), true);
    // ordinary names stay free
    assert.equal(platform.isUsernameRoutingReserved('someuser'), false);
  });

  it('[PLIS2] an issuer outside dns.domain reserves nothing', async () => {
    const platform = makePlatform({ 'oauth:issuer': 'https://auth-eu.example.org' });
    await platform.refreshPlatformNames();
    assert.equal(platform.isUsernameRoutingReserved('auth-eu'), false);
  });

  it('[PLIS3] the domain itself, a deeper name, no dns.domain or no issuer add nothing', async () => {
    for (const config of [
      { 'oauth:issuer': 'https://example.com' },
      { 'oauth:issuer': 'https://auth-eu.eu.example.com' },
      { 'oauth:issuer': 'https://auth-eu.example.com', 'dns:domain': null },
      {}
    ]) {
      const platform = makePlatform(config);
      await platform.refreshPlatformNames();
      for (const name of ['auth-eu', 'example', 'eu']) {
        assert.equal(platform.isUsernameRoutingReserved(name), false, JSON.stringify(config) + ' ' + name);
      }
    }
  });
});
