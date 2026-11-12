/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

/**
 * The access integrity hash covers the object a client receives (composite
 * id and refs, no internal serial fields), whatever form it is computed on:
 * the stored row (head, history row, deletion record) or the wire object.
 */

const assert = require('node:assert/strict');
const stableRepresentation = require('@pryv/stable-object-representation');
const { composeWireAccess } = require('../../src/accesses/refs.ts');

let integrity;

const BASE = 'ckaiwvbase00000000000001';

function baseRow () {
  return {
    id: BASE,
    token: 'ckaiwvtoken0000000000001',
    name: 'aiwv access',
    type: 'shared',
    permissions: [{ streamId: 'diary', level: 'read' }],
    created: 1700000000,
    createdBy: 'ckaiwvcreator00000000001',
    modified: 1700000100,
    modifiedBy: 'ckaiwvmodifier0000000001',
    deleted: null,
    headId: null
  };
}

/** What the bare library computes on the wire form of `row`. */
function wireHash (row) {
  const wire = composeWireAccess(row, typeof row.headId === 'string' ? row.headId : undefined);
  return stableRepresentation.access.hash(wire, integrity.algorithm);
}

describe('[AIWB] access integrity: canonical (wire) form', function () {
  before(function () {
    // Loaded once the test helpers initialised the configuration it reads.
    integrity = require('../../src/integrity/index.ts').default;
  });
  it('[AIWV] stored rows hash as their wire form; the wire form is a fixed point', function () {
    const head = Object.assign(baseRow(), { serial: 2, modifiedBySerial: 1 });
    const history = Object.assign(baseRow(), { id: 'ckaiwvhistory00000000001', headId: BASE, serial: 1 });
    const original = Object.assign(baseRow(), { id: 'ckaiwvhistory00000000002', headId: BASE, serial: null });
    const deletion = Object.assign(baseRow(), { serial: 2, modifiedBySerial: 1, deleted: 1700000200 });
    const withCaller = Object.assign(baseRow(), { serial: 3, modifiedBy: 'ckaiwvapp000000000000001 caller-x', modifiedBySerial: 4 });

    assert.equal(composeWireAccess(history, BASE).id, BASE + ':1');
    assert.equal(composeWireAccess(original, BASE).id, BASE);
    assert.equal(composeWireAccess(withCaller).modifiedBy, 'ckaiwvapp000000000000001:4 caller-x');

    for (const [label, row] of Object.entries({ head, history, original, deletion, withCaller })) {
      const h = integrity.accesses.hash(row);
      assert.equal(h, wireHash(row), label + ': row hash is the wire hash');
      const wire = composeWireAccess(row, typeof row.headId === 'string' ? row.headId : undefined);
      assert.equal(integrity.accesses.hash(wire), h, label + ': the wire form is a fixed point');
      assert.equal(integrity.accesses.compute(row).integrity, h, label + ': compute agrees with hash');
      assert.notEqual(integrity.accesses.rowFormHash(row), h, label + ': the row form differs');
    }
    assert.equal(integrity.accesses.key(head), 'ACCESS:0:' + BASE + ':2:' + head.modified);
  });

  it('[AIWW] a never-updated row hashes the same in both forms, and `usage` is left out', function () {
    const row = baseRow();
    assert.equal(integrity.accesses.hash(row), integrity.accesses.rowFormHash(row));
    assert.equal(integrity.accesses.hash(row), stableRepresentation.access.hash(row, integrity.algorithm));
    const withUsage = Object.assign(baseRow(), { usage: { calls: 3 } });
    assert.equal(integrity.accesses.hash(withUsage), integrity.accesses.hash(row));
  });

  it('[AIWY] set() writes the wire hash on the row it is given', function () {
    const row = Object.assign(baseRow(), { serial: 1 });
    const res = integrity.accesses.set(row, true);
    if (!integrity.accesses.isActive) {
      assert.equal(res, undefined);
      return;
    }
    assert.equal(row.integrity, wireHash(row));
    assert.equal(row.serial, 1, 'the row keeps its storage fields');
  });
});
