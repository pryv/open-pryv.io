/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
/**
 * Unit tests for the per-stream permission merge rule (join / meet).
 */

const assert = require('node:assert/strict');

const ps = require('../../src/accesses/permissionSet.ts');

const LEVELS = ['none', 'read', 'create-only', 'contribute', 'manage'];

// Expected results, row = first argument, column = second argument, in the
// order of LEVELS. NULL = no level grants exactly that capability set.
const JOIN_TABLE = `
none         read         create-only  contribute   manage
read         read         NULL         contribute   manage
create-only  NULL         create-only  contribute   manage
contribute   contribute   contribute   contribute   manage
manage       manage       manage       manage       manage
`;
const MEET_TABLE = `
none         none         none         none         none
none         read         NULL         read         read
none         NULL         create-only  create-only  create-only
none         read         create-only  contribute   contribute
none         read         create-only  contribute   manage
`;

function parseTable (text) {
  const rows = text.trim().split('\n').map((line) => line.trim().split(/\s+/));
  assert.equal(rows.length, LEVELS.length);
  const out = [];
  rows.forEach((cells, i) => {
    assert.equal(cells.length, LEVELS.length);
    cells.forEach((cell, j) => out.push([LEVELS[i], LEVELS[j], cell === 'NULL' ? null : cell]));
  });
  return out;
}

describe('[PMRU] permission merge rule', () => {
  describe('[PMRU-L] level join / meet', () => {
    it('[PMRU1] joinLevel matches the table on all 25 pairs', () => {
      const pairs = parseTable(JOIN_TABLE);
      assert.equal(pairs.length, 25);
      for (const [a, b, expected] of pairs) {
        assert.equal(ps.joinLevel(a, b), expected, `joinLevel(${a}, ${b})`);
      }
    });

    it('[PMRU2] meetLevel matches the table on all 25 pairs', () => {
      const pairs = parseTable(MEET_TABLE);
      assert.equal(pairs.length, 25);
      for (const [a, b, expected] of pairs) {
        assert.equal(ps.meetLevel(a, b), expected, `meetLevel(${a}, ${b})`);
      }
    });

    it('[PMRU3] a non-null join / meet grants exactly the union / intersection of capabilities', () => {
      const caps = (l) => ps.capabilitiesForLevel(l);
      for (const a of LEVELS) {
        for (const b of LEVELS) {
          const j = ps.joinLevel(a, b);
          const m = ps.meetLevel(a, b);
          for (const c of ['read', 'create', 'update', 'manage', 'list']) {
            if (j != null) assert.equal(caps(j)[c], caps(a)[c] || caps(b)[c], `join ${a} ${b} ${c}`);
            if (m != null) assert.equal(caps(m)[c], caps(a)[c] && caps(b)[c], `meet ${a} ${b} ${c}`);
          }
        }
      }
    });
  });

  describe('[PMRU-S] stream entries', () => {
    it('[PMRU4] join: a stream in both sets gets the joined level, a stream in one set is kept', () => {
      const r = ps.mergeStreamPermissions(
        [{ streamId: 'a', level: 'read' }, { streamId: 'b', level: 'manage' }],
        [{ streamId: 'a', level: 'contribute' }, { streamId: 'c', level: 'read' }],
        'join');
      assert.deepEqual(r.conflicts, []);
      assert.deepEqual(r.permissions, [
        { streamId: 'a', level: 'contribute' },
        { streamId: 'b', level: 'manage' },
        { streamId: 'c', level: 'read' }
      ]);
    });

    it('[PMRU5] join: read with create-only is a conflict, the stream is left out', () => {
      for (const [cur, inc] of [['read', 'create-only'], ['create-only', 'read']]) {
        const r = ps.mergeStreamPermissions(
          [{ streamId: 'a', level: cur }, { streamId: 'b', level: 'read' }],
          [{ streamId: ':local:a', level: inc }],
          'join');
        assert.deepEqual(r.conflicts, [{ streamId: 'a', current: cur, incoming: inc }]);
        assert.deepEqual(r.permissions, [{ streamId: 'b', level: 'read' }]);
      }
    });

    it('[PMRU6] meet: a stream in both sets gets the met level (none when no level is common), a stream in one set is left out', () => {
      const r = ps.mergeStreamPermissions(
        [{ streamId: 'a', level: 'contribute' }, { streamId: 'b', level: 'read' },
          { streamId: 'c', level: 'manage' }, { streamId: 'd', level: 'read' }],
        [{ streamId: 'a', level: 'read' }, { streamId: 'b', level: 'create-only' },
          { streamId: 'c', level: 'manage' }, { streamId: 'e', level: 'read' }],
        'meet');
      assert.deepEqual(r.conflicts, []);
      assert.deepEqual(r.permissions, [
        { streamId: 'a', level: 'read' },
        { streamId: 'b', level: 'none' },
        { streamId: 'c', level: 'manage' }
      ]);
    });

    it('[PMRU17] meet: no common level emits none with current\'s spelling, in both orders', () => {
      for (const [cur, inc] of [['read', 'create-only'], ['create-only', 'read']]) {
        const r = ps.mergeStreamPermissions(
          [{ streamId: ':local:b', level: cur, name: 'B current' }],
          [{ streamId: 'b', level: inc, name: 'B incoming' }],
          'meet');
        assert.deepEqual(r.conflicts, []);
        assert.deepEqual(r.permissions, [{ streamId: ':local:b', level: 'none', name: 'B current' }]);
      }
    });

    it('[PMRU18] meet: a none entry in one set only is kept, on either side; join keeps it too', () => {
      const r = ps.mergeStreamPermissions(
        [{ streamId: 'p', level: 'read' }, { streamId: 'p-c1', level: 'none' }],
        [{ streamId: 'p', level: 'read' }, { streamId: 'p-c2', level: 'none' }, { streamId: 'q', level: 'read' }],
        'meet');
      assert.deepEqual(r.permissions, [
        { streamId: 'p', level: 'read' },
        { streamId: 'p-c1', level: 'none' },
        { streamId: 'p-c2', level: 'none' }
      ]);
      assert.deepEqual(ps.mergeStreamPermissions([{ streamId: 'x', level: 'none' }], [], 'join').permissions,
        [{ streamId: 'x', level: 'none' }]);
    });

    it('[PMRU7] streams are compared by canonical id', () => {
      const r = ps.mergeStreamPermissions(
        [{ streamId: ':local:a', level: 'read' }, { streamId: '*', level: 'read' }],
        [{ streamId: 'a', level: 'contribute' }, { streamId: ':local:*', level: 'read' }],
        'join');
      assert.deepEqual(r.permissions, [
        { streamId: 'a', level: 'contribute' },
        { streamId: '*', level: 'read' }
      ]);
    });

    it('[PMRU8] the emitted entry keeps the spelling and names of the side whose level is kept, current when equal', () => {
      const cur = [
        { streamId: ':local:a', level: 'read', defaultName: 'A current' },
        { streamId: 'b', level: 'manage', name: 'B current' },
        { streamId: 'c', level: 'read', defaultName: 'C current' }
      ];
      const inc = [
        { streamId: 'a', level: 'contribute', defaultName: 'A incoming' },
        { streamId: ':local:b', level: 'read', name: 'B incoming' },
        { streamId: ':local:c', level: 'read', defaultName: 'C incoming' }
      ];
      assert.deepEqual(ps.mergeStreamPermissions(cur, inc, 'join').permissions, [
        { streamId: 'a', level: 'contribute', defaultName: 'A incoming' },
        { streamId: 'b', level: 'manage', name: 'B current' },
        { streamId: 'c', level: 'read', defaultName: 'C current' }
      ]);
      assert.deepEqual(ps.mergeStreamPermissions(cur, inc, 'meet').permissions, [
        { streamId: ':local:a', level: 'read', defaultName: 'A current' },
        { streamId: ':local:b', level: 'read', name: 'B incoming' },
        { streamId: 'c', level: 'read', defaultName: 'C current' }
      ]);
    });

    it('[PMRU9] order: current entries in place, then new entries in incoming order; a no-op merge round-trips', () => {
      const cur = [
        { streamId: 'z', level: 'read' },
        { feature: 'webhooks', setting: 'forbidden' },
        { streamId: 'a', level: 'read' }
      ];
      const r = ps.mergeStreamPermissions(cur,
        [{ streamId: 'n2', level: 'read' }, { streamId: 'a', level: 'manage' }, { streamId: 'n1', level: 'read' }],
        'join');
      assert.deepEqual(r.permissions, [
        { streamId: 'z', level: 'read' },
        { feature: 'webhooks', setting: 'forbidden' },
        { streamId: 'a', level: 'manage' },
        { streamId: 'n2', level: 'read' },
        { streamId: 'n1', level: 'read' }
      ]);
      assert.deepEqual(ps.mergeStreamPermissions(cur, [], 'join').permissions, cur);
      assert.deepEqual(ps.mergeStreamPermissions(cur, cur, 'meet').permissions, cur);
    });

    it('[PMRU10] duplicates inside one set collapse to the last entry (in any spelling), at the first position', () => {
      const legacy = [
        { streamId: 'a', level: 'read' },
        { streamId: 'x', level: 'read' },
        { streamId: ':local:a', level: 'contribute' }
      ];
      assert.deepEqual(ps.mergeStreamPermissions(legacy, [{ streamId: 'b', level: 'read' }], 'join').permissions, [
        { streamId: ':local:a', level: 'contribute' },
        { streamId: 'x', level: 'read' },
        { streamId: 'b', level: 'read' }
      ]);
      // incoming duplicates collapse the same way
      assert.deepEqual(ps.mergeStreamPermissions([],
        [{ streamId: 'a', level: 'manage' }, { streamId: 'a', level: 'read' }], 'join').permissions,
      [{ streamId: 'a', level: 'read' }]);
      // the collapsed row differs from the stored one by key set
      const keys = (perms) => new Set(perms.map(ps.permissionKey));
      const merged = ps.mergeStreamPermissions(legacy, [], 'join').permissions;
      assert.notDeepEqual(keys(merged), keys(legacy));
    });

    it('[PMRU11] consent annotations are dropped', () => {
      const r = ps.mergeStreamPermissions([],
        [{ streamId: 'a', level: 'read', mandatory: true }, { feature: 'webhooks', setting: 'forbidden', optIn: true }],
        'join');
      assert.deepEqual(r.permissions, [{ streamId: 'a', level: 'read' }, { feature: 'webhooks', setting: 'forbidden' }]);
    });
  });

  describe('[PMRU-F] feature entries', () => {
    const f = (feature, setting) => ({ feature, setting });

    it('[PMRU12] join: forbidden if either side forbids, else allowed when either side has the entry', () => {
      const r = ps.mergeStreamPermissions(
        [f('webhooks', 'allowed'), f('selfRevoke', 'forbidden'), f('secretSharing', 'allowed')],
        [f('webhooks', 'forbidden'), f('selfRevoke', 'allowed'), f('accessX', 'allowed')],
        'join');
      assert.deepEqual(r.permissions, [
        f('webhooks', 'forbidden'), f('selfRevoke', 'forbidden'), f('secretSharing', 'allowed'), f('accessX', 'allowed')
      ]);
    });

    it('[PMRU13] meet: forbidden if either side forbids, allowed only when both allow, else left out', () => {
      const r = ps.mergeStreamPermissions(
        [f('webhooks', 'allowed'), f('selfRevoke', 'allowed'), f('secretSharing', 'allowed'), f('x', 'forbidden')],
        [f('webhooks', 'forbidden'), f('selfRevoke', 'allowed'), f('y', 'allowed'), f('z', 'forbidden')],
        'meet');
      assert.deepEqual(r.permissions, [
        f('webhooks', 'forbidden'), f('selfRevoke', 'allowed'), f('x', 'forbidden'), f('z', 'forbidden')
      ]);
    });

    it('[PMRU14] two entries for one feature in a set count as forbidden if either is', () => {
      const r = ps.mergeStreamPermissions([f('webhooks', 'forbidden'), f('webhooks', 'allowed')], [], 'join');
      assert.deepEqual(r.permissions, [f('webhooks', 'forbidden')]);
    });
  });

  describe('[PMRU-E] conflict error', () => {
    it('[PMRU15] PermissionMergeConflictError carries the code, the conflicts and a message naming stream and levels', () => {
      const conflicts = [{ streamId: 'a', current: 'read', incoming: 'create-only' }];
      const err = new ps.PermissionMergeConflictError(conflicts);
      assert.ok(err instanceof Error);
      assert.equal(err.code, 'permission-level-conflict');
      assert.deepEqual(err.conflicts, conflicts);
      assert.match(err.message, /"a"/);
      assert.match(err.message, /"read"/);
      assert.match(err.message, /"create-only"/);
      assert.match(err.message, /contribute/);
    });

    it('[PMRU16] a non-array is refused; an entry that is neither a stream nor a feature permission is skipped, not refused', () => {
      assert.throws(() => ps.mergeStreamPermissions('nope', [], 'join'));
      assert.throws(() => ps.mergeStreamPermissions([], null, 'meet'));
      assert.deepEqual(ps.mergeStreamPermissions([], [{ streamId: 'a', level: 'all' }], 'meet').permissions, []);
      assert.deepEqual(ps.mergeStreamPermissions([], [{ streamId: null, level: 'read' }], 'join').permissions, []);
    });

    it('[PMRU19] join re-emits current\'s unclassifiable entries as is at their position; meet leaves them out', () => {
      const stored = [
        { streamId: 'a', level: 'read' },
        { streamId: null, level: 'read' },
        { feature: 'webhooks', setting: 'forbidden' }
      ];
      assert.deepEqual(ps.mergeStreamPermissions(stored, [], 'join').permissions, stored);
      assert.deepEqual(ps.mergeStreamPermissions(stored, [{ streamId: 'b', level: 'read' }], 'join').permissions,
        stored.concat([{ streamId: 'b', level: 'read' }]));
      assert.deepEqual(ps.mergeStreamPermissions(stored, stored, 'meet').permissions, [
        { streamId: 'a', level: 'read' },
        { feature: 'webhooks', setting: 'forbidden' }
      ]);
      const keys = (perms) => new Set(perms.map(ps.permissionKey));
      assert.deepEqual(keys(ps.mergeStreamPermissions(stored, [], 'join').permissions), keys(stored));
    });
  });
});
