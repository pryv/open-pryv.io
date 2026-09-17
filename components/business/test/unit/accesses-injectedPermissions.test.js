/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
/**
 * Unit tests for the server-injected permission predicate shared by
 * `accesses.checkApp` and the auth-request consent check.
 */

const assert = require('node:assert/strict');

const { isInjectedPermission, withoutInjectedPermissions } =
  require('../../src/accesses/injectedPermissions.ts');
const accountStreams = require('../../src/system-streams/index.ts');

const ACCOUNT = accountStreams.STREAM_ID_ACCOUNT;

describe('[INJP] server-injected permissions', () => {
  it('[IP01] recognizes the two entries AccessLogic injects', () => {
    assert.equal(isInjectedPermission({ streamId: ACCOUNT, level: 'none' }, 'acc-1'), true);
    assert.equal(isInjectedPermission({ streamId: ':_audit:access-acc-1', level: 'read' }, 'acc-1'), true);
  });

  it('[IP02] leaves a real permission alone, including a lookalike', () => {
    assert.equal(isInjectedPermission({ streamId: 'diary', level: 'read' }, 'acc-1'), false);
    assert.equal(isInjectedPermission({ feature: 'selfRevoke', setting: 'forbidden' }, 'acc-1'), false);
    // Same stream, different level: the injected account entry is `none`,
    // so an explicit read on the account streams is a real grant.
    assert.equal(isInjectedPermission({ streamId: ACCOUNT, level: 'read' }, 'acc-1'), false);
    // Same shape, ANOTHER access's audit stream: that is an explicitly
    // granted permission and dropping it would hide a real grant.
    assert.equal(isInjectedPermission({ streamId: ':_audit:access-acc-2', level: 'read' }, 'acc-1'), false);
    assert.equal(isInjectedPermission({ streamId: ':_audit:access-acc-1', level: 'contribute' }, 'acc-1'), false);
  });

  it('[IP03] without an access id only the account entry is injected', () => {
    // An access still being created has no id yet, so nothing can claim to
    // be its audit stream.
    assert.equal(isInjectedPermission({ streamId: ACCOUNT, level: 'none' }, null), true);
    assert.equal(isInjectedPermission({ streamId: ':_audit:access-acc-1', level: 'read' }, null), false);
  });

  it('[IP04] subtracts them from a permission list, leaving order intact', () => {
    const permissions = [
      { streamId: ACCOUNT, level: 'none' },
      { streamId: 'diary', level: 'read' },
      { feature: 'selfRevoke', setting: 'forbidden' },
      { streamId: ':_audit:access-acc-1', level: 'read' },
    ];
    assert.deepEqual(withoutInjectedPermissions(permissions, 'acc-1'), [
      { streamId: 'diary', level: 'read' },
      { feature: 'selfRevoke', setting: 'forbidden' },
    ]);
  });

  it('[IP05] a personal access (no permissions) yields an empty list, never a throw', () => {
    // A personal access grants everything, which is never a valid answer to
    // a scoped consent offer; the caller sees an empty grant and refuses.
    assert.deepEqual(withoutInjectedPermissions(undefined, 'acc-1'), []);
    assert.deepEqual(withoutInjectedPermissions(null, 'acc-1'), []);
    assert.deepEqual(withoutInjectedPermissions([], 'acc-1'), []);
  });
});
