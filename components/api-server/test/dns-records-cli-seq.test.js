/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/* global initTests, initCore, assert */

const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawnSync } = require('child_process');
const yaml = require('js-yaml');
const cuid = require('cuid');

const CLI = path.resolve(__dirname, '../../../bin/dns-records.js');

function runCli (args) {
  // Spawn the CLI as a child process so it exercises the real boiler + rqlite path.
  const res = spawnSync('node', [CLI, ...args], {
    cwd: path.resolve(__dirname, '../../../'),
    encoding: 'utf8',
    timeout: 30000
  });
  return { status: res.status, stdout: res.stdout || '', stderr: res.stderr || '' };
}

describe('[DNSCLI] bin/dns-records.js CLI', () => {
  let platform;
  let tmpDir;

  before(async function () {
    this.timeout(30000);
    await initTests();
    await initCore();
    const { getPlatform } = require('platform');
    platform = await getPlatform();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dns-cli-'));
  });

  after(() => {
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  async function cleanupSubdomains (subs) {
    for (const s of subs) {
      await platform.deleteDnsRecord(s).catch(() => {});
    }
  }

  it('[DC01] --help prints usage and exits 0', () => {
    const res = runCli(['--help']);
    assert.strictEqual(res.status, 0);
    assert.match(res.stdout, /Usage:/);
    assert.match(res.stdout, /load <file>/);
  });

  it('[DC02] list, load, export, delete round-trip via CLI', async () => {
    const subA = '_dnscli-a-' + cuid();
    const subB = '_dnscli-b-' + cuid();
    const yamlPath = path.join(tmpDir, 'dc02.yaml');
    const exportPath = path.join(tmpDir, 'dc02-out.yaml');

    fs.writeFileSync(yamlPath, yaml.dump({
      records: [
        { subdomain: subA, records: { txt: ['dc02-a'] } },
        { subdomain: subB, records: { a: ['10.0.0.2'] } }
      ]
    }));

    // dry-run writes nothing
    let res = runCli(['load', yamlPath, '--dry-run']);
    assert.strictEqual(res.status, 0, res.stderr);
    assert.match(res.stdout, /\+2 added/);
    assert.strictEqual(await platform.getDnsRecord(subA), null);

    // real load persists both
    res = runCli(['load', yamlPath]);
    assert.strictEqual(res.status, 0, res.stderr);
    assert.deepStrictEqual(await platform.getDnsRecord(subA), { txt: ['dc02-a'] });
    assert.deepStrictEqual(await platform.getDnsRecord(subB), { a: ['10.0.0.2'] });

    // export round-trip
    res = runCli(['export', exportPath]);
    assert.strictEqual(res.status, 0, res.stderr);
    const exported = yaml.load(fs.readFileSync(exportPath, 'utf8'));
    const exportedMap = new Map(exported.records.map(r => [r.subdomain, r.records]));
    assert.deepStrictEqual(exportedMap.get(subA), { txt: ['dc02-a'] });
    assert.deepStrictEqual(exportedMap.get(subB), { a: ['10.0.0.2'] });

    // delete one subdomain
    res = runCli(['delete', subA]);
    assert.strictEqual(res.status, 0, res.stderr);
    assert.strictEqual(await platform.getDnsRecord(subA), null);
    assert.deepStrictEqual(await platform.getDnsRecord(subB), { a: ['10.0.0.2'] });

    await cleanupSubdomains([subA, subB]);
  });

  it('[DC03] --replace removes records absent from file', async () => {
    const subKeep = '_dnscli-keep-' + cuid();
    const subGone = '_dnscli-gone-' + cuid();
    await platform.setDnsRecord(subKeep, { txt: ['keep'] });
    await platform.setDnsRecord(subGone, { txt: ['gone'] });

    const yamlPath = path.join(tmpDir, 'dc03.yaml');
    fs.writeFileSync(yamlPath, yaml.dump({
      records: [{ subdomain: subKeep, records: { txt: ['keep'] } }]
    }));

    const res = runCli(['load', yamlPath, '--replace']);
    assert.strictEqual(res.status, 0, res.stderr);
    assert.match(res.stdout, /-1 removed/);

    assert.deepStrictEqual(await platform.getDnsRecord(subKeep), { txt: ['keep'] });
    assert.strictEqual(await platform.getDnsRecord(subGone), null);

    await cleanupSubdomains([subKeep, subGone]);
  });

  it('[DC04] delete on missing subdomain exits non-zero', async () => {
    const res = runCli(['delete', '_never-existed-' + cuid()]);
    assert.notStrictEqual(res.status, 0);
    assert.match(res.stderr, /No record for subdomain/);
  });

  it('[DC05] load rejects malformed file', () => {
    const yamlPath = path.join(tmpDir, 'dc05.yaml');
    fs.writeFileSync(yamlPath, 'not: a valid records list\n');
    const res = runCli(['load', yamlPath]);
    assert.notStrictEqual(res.status, 0);
    assert.match(res.stderr, /records:/);
  });
});
