/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
const require = createRequire(import.meta.url);
const __dirname = dirname(fileURLToPath(import.meta.url));
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
    assert.match(res.stdout, /set-endpoint/);
    assert.match(res.stdout, /set-header/);
  });

  it('[OC02] show on a fresh cluster reports unset', () => {
    const res = runCli(['show']);
    assert.strictEqual(res.status, 0, res.stderr);
    assert.match(res.stdout, /enabled:\s+false/);
    assert.match(res.stdout, /otlp endpoint:\s+\(unset\)/);
    assert.match(res.stdout, /otlp headers set: none/);
  });

  it('[OC03] set-endpoint + set-header + enable round-trip, secrets never echoed', async () => {
    const apiKey = 'test-key-' + cuid() + '-01234567890123456789';

    // Without an endpoint, `enable` must warn but still succeed.
    const enableBefore = runCli(['enable']);
    assert.strictEqual(enableBefore.status, 0, enableBefore.stderr);
    assert.match(enableBefore.stderr, /no endpoint is set/);

    const endpointRes = runCli(['set-endpoint', 'https://otlp.eu01.example.test']);
    assert.strictEqual(endpointRes.status, 0, endpointRes.stderr);

    const headerRes = runCli(['set-header', 'api-key', apiKey]);
    assert.strictEqual(headerRes.status, 0, headerRes.stderr);
    assert.match(headerRes.stdout, /encrypted at rest/);

    const showRes = runCli(['show']);
    assert.match(showRes.stdout, /enabled:\s+true/);
    assert.match(showRes.stdout, /otlp endpoint:\s+https:\/\/otlp\.eu01\.example\.test/);
    assert.match(showRes.stdout, /otlp headers set: api-key \(values hidden\)/);
    // The credential must NEVER appear in `show` output.
    assert.doesNotMatch(showRes.stdout, new RegExp(apiKey));
    assert.doesNotMatch(showRes.stderr, new RegExp(apiKey));
  });

  it('[OC04] set-endpoint rejects a malformed URL', () => {
    const res = runCli(['set-endpoint', 'not-a-url']);
    assert.notStrictEqual(res.status, 0);
    assert.match(res.stderr, /not a valid URL/);
  });

  it('[OC05] set-endpoint refuses a non-HTTPS remote destination', () => {
    const res = runCli(['set-endpoint', 'http://otlp.example.test']);
    assert.notStrictEqual(res.status, 0);
    assert.match(res.stderr, /refusing cleartext telemetry/);
  });

  it('[OC06] set-endpoint allows a plain-HTTP local collector', () => {
    // The usual zero-egress deployment: an OpenTelemetry Collector on the
    // same host, inside the operator's trust boundary.
    const res = runCli(['set-endpoint', 'http://localhost:4318']);
    assert.strictEqual(res.status, 0, res.stderr);
    const show = runCli(['show']);
    assert.match(show.stdout, /otlp endpoint:\s+http:\/\/localhost:4318/);
  });

  it('[OC09] set-endpoint allows a plain-HTTP collector on the container bridge', () => {
    // The sidecar shape the zero-egress guidance actually describes: the
    // collector is a separate container, so the core reaches it on the
    // bridge gateway rather than on loopback. Same trust boundary, no
    // certificate needed for a hop that never crosses a network.
    const res = runCli(['set-endpoint', 'http://172.17.0.1:4318']);
    assert.strictEqual(res.status, 0, res.stderr);
    const show = runCli(['show']);
    assert.match(show.stdout, /otlp endpoint:\s+http:\/\/172\.17\.0\.1:4318/);
  });

  it('[OC10] set-endpoint still refuses cleartext just outside private space', () => {
    // 172.15/16 and 172.32/16 bracket RFC1918's 172.16/12: an off-by-one in
    // the range check would open cleartext to the public internet.
    for (const url of ['http://172.15.0.1:4318', 'http://172.32.0.1:4318']) {
      const res = runCli(['set-endpoint', url]);
      assert.notStrictEqual(res.status, 0, url + ' must be refused');
      assert.match(res.stderr, /not host-local/);
    }
  });

  it('[OC07] clear-headers removes stored credentials', () => {
    runCli(['set-header', 'api-key', 'some-value-0123456789']);
    const clearRes = runCli(['clear-headers']);
    assert.strictEqual(clearRes.status, 0, clearRes.stderr);
    const show = runCli(['show']);
    assert.match(show.stdout, /otlp headers set: none/);
  });

  it('[OC08] disable clears the flag', async () => {
    runCli(['set-endpoint', 'https://otlp.example.test']);
    runCli(['enable']);

    const disableRes = runCli(['disable']);
    assert.strictEqual(disableRes.status, 0, disableRes.stderr);

    const showRes = runCli(['show']);
    assert.match(showRes.stdout, /enabled:\s+false/);
  });
});
