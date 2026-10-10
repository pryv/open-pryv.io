/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
/**
 * An AccessLogic held in the access cache is shared by every request using
 * the same token. Loading its permissions must never expose, even for one
 * microtask, a view emptier than the stored permissions: feature permissions
 * default to allow when absent, and a missing `none` entry or forced stream
 * widens what the token reaches.
 */

const assert = require('node:assert/strict');
const { AccessLogic } = require('../../src/accesses/AccessLogic.ts');

const FILLER_STREAMS = 40;

function restrictedAccess () {
  const permissions = [];
  for (let i = 0; i < FILLER_STREAMS; i++) {
    permissions.push({ streamId: 'filler-' + i, level: 'read' });
  }
  permissions.push(
    { streamId: 'diary', level: 'read' },
    { streamId: 'diary-private', level: 'none' },
    { feature: 'webhooks', setting: 'forbidden' },
    { feature: 'selfRevoke', setting: 'forbidden' },
    { feature: 'secretSharing', setting: 'forbidden' },
    { feature: 'forcedStreams', streams: ['forced'] }
  );
  return new AccessLogic('apld-user', { id: 'apld-access', type: 'app', token: 'apld-token', permissions });
}

/** Throws when any restriction of `restrictedAccess()` is not visible. */
function assertRestrictionsVisible (logic, when) {
  assert.equal(logic.canUseWebhooks(), false, when + ': webhooks must stay forbidden');
  assert.equal(logic._canSelfRevoke(), false, when + ': selfRevoke must stay forbidden');
  assert.equal(logic.canCreateSharedSecrets(), false, when + ': secretSharing must stay forbidden');
  assert.ok(logic.getCannotListStreamsStreamIds('local').includes('diary-private'), when + ': the none entry must be listed');
  assert.ok(logic.getForbiddenGetEventsStreamIds('local').includes('diary-private'), when + ': the none entry must be excluded from reads');
  assert.deepEqual(logic.getForcedStreamsGetEventsStreamIds('local'), ['forced'], when + ': forced streams must be present');
  assert.equal(logic.getStreamPermission('local', 'diary').level, 'read', when + ': the stream grant must be present');
}

/** Runs `check` now and after every microtask until `promise` settles. */
async function checkOnEveryTick (promise, check) {
  const state = { settled: false };
  promise.then(() => { state.settled = true; }, () => { state.settled = true; });
  let ticks = 0;
  check('tick ' + ticks);
  while (!state.settled) {
    await null;
    ticks++;
    check('tick ' + ticks);
  }
  await promise;
  return ticks;
}

describe('[APLD] access permission loading', function () {
  it('[APLD1] loading again an access already loaded never exposes default permissions', async function () {
    const logic = restrictedAccess();
    await logic.loadPermissions();
    assertRestrictionsVisible(logic, 'after the first load');
    await checkOnEveryTick(logic.loadPermissions(), (when) => assertRestrictionsVisible(logic, 'during a second load, ' + when));
    assertRestrictionsVisible(logic, 'after the second load');
  });

  it('[APLD2] concurrent first loads leave one complete permission view', async function () {
    const logic = restrictedAccess();
    const first = logic.loadPermissions();
    const second = logic.loadPermissions();
    await Promise.all([first, second]);
    assertRestrictionsVisible(logic, 'after concurrent loads');
    // A load started once the maps are built keeps them visible throughout.
    await checkOnEveryTick(logic.loadPermissions(), (when) => assertRestrictionsVisible(logic, 'during a later load, ' + when));
  });

  it('[APLD3] the permission maps are swapped in one step, never filled in place', async function () {
    const logic = restrictedAccess();
    await logic.loadPermissions();
    const before = {
      features: logic.featurePermissionsMap,
      streams: logic._streamByStorePermissionsMap,
      forced: logic._streamByStoreForced
    };
    await checkOnEveryTick(logic.loadPermissions(), (when) => {
      // Whatever object is current, it is never a partial one.
      assert.ok(logic.featurePermissionsMap.webhooks != null, when);
      assert.ok(logic._streamByStorePermissionsMap.local['diary-private'] != null, when);
    });
    // The maps observed before are left untouched by any later load.
    assert.equal(before.features.webhooks.setting, 'forbidden');
    assert.equal(before.streams.local['diary-private'].level, 'none');
    assert.deepEqual(before.forced.local, ['forced']);
  });
});
