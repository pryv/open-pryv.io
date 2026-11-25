/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

/**
 * [CVAE] Boot warning: audit records in PostgreSQL with the base storage in
 * SQLite, where a record of the last moment of an erasure is not refused.
 */

const assert = require('node:assert/strict');
const { collectWarnings } = require('../../../config/plugins/config-validation.js');

/** A config with mail off (no unrelated warning) plus the given engines and audit settings. */
function config (base, audit, auditSettings) {
  const all = {
    services: { email: { enabled: false } },
    auth: { adminAccessKey: 'admin-key-'.repeat(4) },
    storages: { base: { engine: base }, audit: { engine: audit } },
    audit: auditSettings
  };
  const get = (key) => key == null ? all : key.split(':').reduce((node, seg) => (node == null ? undefined : node[seg]), all);
  return { get, getScopeAndValue: (key) => ({ value: get(key), scope: 'override-file', info: '' }) };
}

const auditWarnings = (base, audit, auditSettings = { active: true, onUserDelete: 'erase' }) =>
  collectWarnings(config(base, audit, auditSettings)).filter((w) => w.includes("'storages.audit.engine"));

describe('[CVAE] audit engine boot warning', () => {
  it('[CVAE1] PostgreSQL audit on a SQLite base is reported once, naming both settings', () => {
    const found = auditWarnings('sqlite', 'postgresql');
    assert.equal(found.length, 1);
    assert.match(found[0], /'storages\.audit\.engine: postgresql' with 'storages\.base\.engine: sqlite'/);
    assert.match(found[0], /last moment of an account erasure/);
  });

  it('[CVAE2] every other pairing is silent', () => {
    assert.deepEqual(auditWarnings('sqlite', 'sqlite'), []);
    assert.deepEqual(auditWarnings('postgresql', 'sqlite'), []);
    assert.deepEqual(auditWarnings('postgresql', 'postgresql'), []);
  });

  it('[CVAE3] silent when trails of erased accounts are kept, or the audit is off', () => {
    assert.deepEqual(auditWarnings('sqlite', 'postgresql', { active: true, onUserDelete: 'keep' }), []);
    assert.deepEqual(auditWarnings('sqlite', 'postgresql', { active: false, onUserDelete: 'erase' }), []);
  });

  it('[CVAE4] the default of audit.onUserDelete (unset) is reported like erase', () => {
    assert.equal(auditWarnings('sqlite', 'postgresql', { active: true }).length, 1);
  });
});

describe('[CVAF] audit filter boot warning', () => {
  const filterWarnings = (audit) => collectWarnings(config('postgresql', 'postgresql', audit)).filter((w) => w.includes(".filter'"));
  const filter = (include, exclude = []) => ({ filter: { methods: { include, exclude } } });

  it('[CVAF1] names the entries that match no method, per filter, and stays silent on valid ones', () => {
    const found = filterWarnings({ active: true, storage: filter(['event.get', 'events.get']), syslog: filter(['all'], ['accesses.al']) });
    assert.equal(found.length, 2, JSON.stringify(found));
    assert.match(found[0], /^'audit\.storage\.filter' .*"event\.get"\./);
    assert.ok(!found[0].includes('"events.get"'));
    assert.match(found[1], /^'audit\.syslog\.filter' .*"accesses\.al"/);
    assert.deepEqual(filterWarnings({ active: true, storage: filter(['events.all', 'accesses.deleted']), syslog: filter(['all']) }), []);
    assert.deepEqual(filterWarnings({ active: false, storage: filter(['event.get']), syslog: filter(['all']) }), []);
  });

  it('[CVAF2] the shipped defaults are silent', () => {
    const yaml = require('js-yaml');
    const fs = require('node:fs');
    const defaults = yaml.load(fs.readFileSync(new URL('../../../config/default-config.yml', import.meta.url), 'utf8'));
    assert.deepEqual(filterWarnings(defaults.audit), []);
  });
});
