/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/**
 * Unit tests for the write-time integrity guard in AccessesPG.applyDefaults.
 * The guard fails loudly, at the write site, if integrity is active but the
 * access being persisted carries no `integrity` value — instead of letting
 * the gap surface one operation later as an "access has no integrity
 * property" scan failure. applyDefaults touches no database, so these tests
 * drive it directly with a stub db and a stubbed integrity ref.
 */

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { AccessesPG } = require('../src/user/AccessesPG.ts');

// applyDefaults never touches the connection, so a bare stub is enough.
const stubDb = {};

function newAccessParams () {
  return { name: 'guard-test-access', type: 'shared' };
}

describe('[AIGP] AccessesPG write-time integrity guard', function () {
  it('[AIG1] active integrity that sets a value passes and keeps the value', function () {
    const activeSetting = {
      isActive: true,
      set: (item) => { item.integrity = 'ACCESS:0:sha256-stub'; }
    };
    const storage = new AccessesPG(stubDb, activeSetting);
    const out = storage.applyDefaults(newAccessParams());
    assert.strictEqual(out.integrity, 'ACCESS:0:sha256-stub');
  });

  it('[AIG2] active integrity that silently skips the hash throws at the write site', function () {
    const brokenSetting = {
      isActive: true,
      set: () => { /* no-op: models a silently-disabled integrity ref */ }
    };
    const storage = new AccessesPG(stubDb, brokenSetting);
    assert.throws(
      () => storage.applyDefaults(newAccessParams()),
      /access persisted without an integrity property/
    );
  });

  it('[AIG3] inactive integrity is a no-op — no value, no throw', function () {
    const inactiveSetting = { isActive: false, set: () => {} };
    const storage = new AccessesPG(stubDb, inactiveSetting);
    const out = storage.applyDefaults(newAccessParams());
    assert.strictEqual(out.integrity, undefined);
  });

  it('[AIG4] missing integrity ref falls back to inert (inactive) — no throw', function () {
    const storage = new AccessesPG(stubDb);
    assert.strictEqual(storage.integrityInjected, false);
    const out = storage.applyDefaults(newAccessParams());
    assert.strictEqual(out.integrity, undefined);
  });
});
