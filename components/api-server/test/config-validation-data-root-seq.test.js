/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
/* global initTests, initCore, assert */

/**
 * [DRPC] the boot validator refuses, inside the Docker image only, a user data
 * root (storages.engines.sqlite.path) that lands on the container's own
 * filesystem or on a tmpfs while an engine writes durable data there. The
 * mount table is injected, so nothing here depends on the host.
 *
 * `-seq` because the api-server mocha hooks run a Platform DB integrity
 * check; the tests themselves do not touch storage.
 */

const fs = require('node:fs');
const yaml = require('js-yaml');

const OVERLAY_ROOT = '1 0 0:50 / / rw,relatime master:1 - overlay overlay rw,lowerdir=/x';
const PROC = '2 1 0:52 / /proc rw,nosuid - proc proc rw';
function mount (id, mountPoint, fstype) {
  return `${id} 1 8:1 /x ${mountPoint} rw,relatime - ${fstype} /dev/sda1 rw`;
}

describe('[DRPC] config-validation user data root persistence', () => {
  let validation;

  before(async function () {
    this.timeout(30000);
    await initTests();
    await initCore();
    validation = require('../../../config/plugins/config-validation.js');
  });

  const DEFAULT_ENGINES = { base: 'postgresql', file: 'filesystem', audit: 'sqlite', series: 'postgresql' };
  const DISKLESS_ENGINES = { base: 'postgresql', file: 's3', audit: 'postgresql', series: 'postgresql' };

  function fakeConfig (sqlitePath, engines = DEFAULT_ENGINES) {
    const values = {
      'storages:base:engine': engines.base,
      'storages:file:engine': engines.file,
      'storages:audit:engine': engines.audit,
      'storages:series:engine': engines.series,
      'storages:engines:sqlite:path': sqlitePath
    };
    return { get: (key) => values[key] };
  }

  function check (sqlitePath, mountLines, { env = { PRYV_IMAGE_TAG: 'dev' }, engines } = {}) {
    const problems = [];
    const readMountinfo = typeof mountLines === 'function' ? mountLines : () => mountLines.join('\n') + '\n';
    validation.checkUserDataRootPersistence(fakeConfig(sqlitePath, engines), problems, { env, readMountinfo });
    return problems;
  }

  it('[DRP1] outside the image nothing is checked, even on the root filesystem', () => {
    assert.deepStrictEqual(check('/app/var-pryv/users', [OVERLAY_ROOT], { env: {} }), []);
  });

  it('[DRP2] the default root on the container filesystem is a located problem', () => {
    const problems = check('/app/var-pryv/users', [OVERLAY_ROOT, PROC, mount(30, '/app/var-pryv/rqlite-data', 'ext4')]);
    assert.strictEqual(problems.length, 1, JSON.stringify(problems));
    assert.deepStrictEqual(problems[0].path, ['storages', 'engines', 'sqlite', 'path']);
    assert.match(problems[0].message, /ephemeral/);
    assert.match(problems[0].message, /PRYV_EPHEMERAL_DATA_OK/);
    assert.strictEqual(problems[0].payload.mountPoint, '/');
    assert.strictEqual(problems[0].payload.fstype, 'overlay');
  });

  it('[DRP3] a root under a bind mount passes', () => {
    assert.deepStrictEqual(check('/app/data/users', [OVERLAY_ROOT, mount(30, '/app/data', 'ext4')]), []);
  });

  it('[DRP4] a mount exactly at the root passes', () => {
    assert.deepStrictEqual(check('/app/var-pryv/users', [OVERLAY_ROOT, mount(30, '/app/var-pryv/users', 'xfs')]), []);
  });

  it('[DRP5] a tmpfs is ephemeral unless no engine writes durable data there', () => {
    const lines = [OVERLAY_ROOT, mount(30, '/app/var-pryv', 'tmpfs')];
    const problems = check('/app/var-pryv/users', lines);
    assert.strictEqual(problems.length, 1);
    assert.strictEqual(problems[0].payload.fstype, 'tmpfs');
    assert.deepStrictEqual(check('/app/var-pryv/users', lines, { engines: DISKLESS_ENGINES }), []);
  });

  it('[DRP6] PRYV_EPHEMERAL_DATA_OK=true opts out', () => {
    assert.deepStrictEqual(check('/app/var-pryv/users', [OVERLAY_ROOT], { env: { PRYV_IMAGE_TAG: 'dev', PRYV_EPHEMERAL_DATA_OK: 'true' } }), []);
  });

  it('[DRP7] an unreadable mount table skips the check', () => {
    assert.deepStrictEqual(check('/app/var-pryv/users', () => { throw new Error('ENOENT'); }), []);
  });

  it('[DRP8] a mount only covers whole path components', () => {
    const problems = check('/app/data/users', [OVERLAY_ROOT, mount(30, '/app/data2', 'ext4')]);
    assert.strictEqual(problems.length, 1);
    assert.strictEqual(problems[0].payload.mountPoint, '/');
  });

  it('[DRP9] escaped mount points are decoded', () => {
    assert.deepStrictEqual(check('/app/my data/users', [OVERLAY_ROOT, mount(30, '/app/my\\040data', 'ext4')]), []);
  });

  it('[DRP10] at the same mount point the later line wins', () => {
    assert.strictEqual(check('/app/data/users', [OVERLAY_ROOT, mount(30, '/app/data', 'ext4'), mount(31, '/app/data', 'tmpfs')]).length, 1);
    assert.deepStrictEqual(check('/app/data/users', [OVERLAY_ROOT, mount(30, '/app/data', 'tmpfs'), mount(31, '/app/data', 'ext4')]), []);
  });

  it('[DRP11] production-config.yml carries no environment placeholder and no storages block', () => {
    const file = require.resolve('../../../config/production-config.yml');
    const doc = yaml.load(fs.readFileSync(file, 'utf8'));
    assert.strictEqual(doc.storages, undefined);
    const found = [];
    (function walk (node, at) {
      if (typeof node === 'string') {
        if (/\$\{[A-Z_][A-Z0-9_]*\}/.test(node)) found.push(at);
      } else if (node && typeof node === 'object') {
        for (const [k, v] of Object.entries(node)) walk(v, at + '.' + k);
      }
    })(doc, '');
    assert.deepStrictEqual(found, []);
  });
});
