/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/* global initTests, initCore, assert */

const path = require('path');
const { spawnSync } = require('child_process');
const cuid = require('cuid');

const CLI = path.resolve(__dirname, '../../../bin/observability.js');

function runCli (args) {
  const res = spawnSync('node', [CLI, ...args], {
    cwd: path.resolve(__dirname, '../../../'),
    encoding: 'utf8',
    timeout: 30000
  });
  return { status: res.status, stdout: res.stdout || '', stderr: res.stderr || '' };
}

describe('[OBCLI] bin/observability.js CLI', () => {
  let platform;

  before(async function () {
    this.timeout(30000);
    await initTests();
    await initCore();
    const { getPlatform } = require('platform');
    platform = await getPlatform();
  });

  async function cleanup () {
    const rows = await platform._db?.getAllObservabilityValues?.() ||
      await require('storages').platformDB.getAllObservabilityValues();
    for (const { key } of rows) {
      await require('storages').platformDB.deleteObservabilityValue(key);
    }
  }

  afterEach(async () => {
    await cleanup();
  });

  it('[OC01] --help prints usage and exits 0', () => {
    const res = runCli(['--help']);
    assert.strictEqual(res.status, 0, res.stderr);
    assert.match(res.stdout, /Usage:/);
    assert.match(res.stdout, /newrelic set-license-key/);
  });

  it('[OC02] show on a fresh cluster reports unset', () => {
    const res = runCli(['show']);
    assert.strictEqual(res.status, 0, res.stderr);
    assert.match(res.stdout, /enabled:\s+false/);
    assert.match(res.stdout, /provider:\s+\(unset\)/);
    assert.match(res.stdout, /newrelic licenseKey set: no/);
  });

  it('[OC03] newrelic set-license-key + enable newrelic round-trip', async () => {
    const licenseKey = 'test-license-' + cuid() + '-01234567890123456789';

    // Without a key, `enable newrelic` must warn but still succeed.
    const enableBefore = runCli(['enable', 'newrelic']);
    assert.strictEqual(enableBefore.status, 0, enableBefore.stderr);
    assert.match(enableBefore.stderr, /no license key is set/);

    const setRes = runCli(['newrelic', 'set-license-key', licenseKey]);
    assert.strictEqual(setRes.status, 0, setRes.stderr);
    assert.match(setRes.stdout, /newrelic license key rotated/);

    const showRes = runCli(['show']);
    assert.match(showRes.stdout, /enabled:\s+true/);
    assert.match(showRes.stdout, /provider:\s+newrelic/);
    assert.match(showRes.stdout, /newrelic licenseKey set: yes/);
    // License key value must NEVER appear in `show` output.
    assert.doesNotMatch(showRes.stdout, new RegExp(licenseKey));
    assert.doesNotMatch(showRes.stderr, new RegExp(licenseKey));
  });

  it('[OC04] set-log-level rejects unknown levels', () => {
    const res = runCli(['set-log-level', 'trace']);
    assert.notStrictEqual(res.status, 0);
    assert.match(res.stderr, /must be one of/);
  });

  it('[OC05] set-log-level accepts each valid level', async () => {
    for (const level of ['error', 'warn', 'info', 'debug']) {
      const res = runCli(['set-log-level', level]);
      assert.strictEqual(res.status, 0, res.stderr);
      const show = runCli(['show']);
      assert.match(show.stdout, new RegExp('logLevel:\\s+' + level));
    }
  });

  it('[OC06] enable rejects unknown providers', () => {
    const res = runCli(['enable', 'datadog']);
    assert.notStrictEqual(res.status, 0);
    assert.match(res.stderr, /only "newrelic" is currently supported/);
  });

  it('[OC07] disable clears the flag', async () => {
    runCli(['newrelic', 'set-license-key', 'test-key-xyz-01234567890123456789']);
    runCli(['enable', 'newrelic']);

    const disableRes = runCli(['disable']);
    assert.strictEqual(disableRes.status, 0, disableRes.stderr);

    const showRes = runCli(['show']);
    assert.match(showRes.stdout, /enabled:\s+false/);
  });
});
