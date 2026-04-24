/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/* global initTests, initCore, assert */

const path = require('path');
const fs = require('node:fs/promises');
const os = require('node:os');
const { spawnSync } = require('child_process');
const cuid = require('cuid');

const CLI = path.resolve(__dirname, '../../../bin/mail.js');
const REPO_ROOT = path.resolve(__dirname, '../../../');

function runCli (args) {
  const res = spawnSync('node', [CLI, ...args], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    timeout: 30000
  });
  return { status: res.status, stdout: res.stdout || '', stderr: res.stderr || '' };
}

describe('[MAILCLI] bin/mail.js CLI', () => {
  let platformDB;

  before(async function () {
    this.timeout(30000);
    await initTests();
    await initCore();
    platformDB = require('storages').platformDB;
  });

  async function cleanup () {
    const rows = await platformDB.getAllMailTemplates();
    for (const r of rows) {
      await platformDB.deleteMailTemplate(r.type, r.lang, r.part);
    }
  }

  afterEach(async () => { await cleanup(); });

  it('[MC01] --help prints usage and exits 0', () => {
    const res = runCli(['--help']);
    assert.strictEqual(res.status, 0, res.stderr);
    assert.match(res.stdout, /Usage:/);
    assert.match(res.stdout, /templates list/);
    assert.match(res.stdout, /send-test/);
  });

  it('[MC02] templates list on empty PlatformDB reports "(no templates ...)"', () => {
    const res = runCli(['templates', 'list']);
    assert.strictEqual(res.status, 0, res.stderr);
    assert.match(res.stdout, /no templates/);
  });

  it('[MC03] templates set writes a Pug source and get returns it', async () => {
    const type = 'welcome-' + cuid();
    const tmpFile = path.join(os.tmpdir(), 'pryv-mailcli-' + cuid() + '.pug');
    const src = '| Hello from MAILCLI ' + cuid();
    await fs.writeFile(tmpFile, src, 'utf8');

    const setRes = runCli(['templates', 'set', type, 'en', 'subject', '--file', tmpFile]);
    assert.strictEqual(setRes.status, 0, setRes.stderr);
    assert.match(setRes.stdout, new RegExp('set ' + type + '/en/subject'));

    const getRes = runCli(['templates', 'get', type, 'en', 'subject']);
    assert.strictEqual(getRes.status, 0, getRes.stderr);
    assert.ok(getRes.stdout.includes(src), 'stdout should contain the original source');

    await fs.unlink(tmpFile);
  });

  it('[MC04] templates list after write shows the new row in tab-separated shape', async () => {
    const type = 'list-' + cuid();
    await platformDB.setMailTemplate(type, 'fr', 'html', 'p bonjour');
    const listRes = runCli(['templates', 'list']);
    assert.strictEqual(listRes.status, 0, listRes.stderr);
    assert.match(listRes.stdout, /type\tlang\tpart\tlen/);
    assert.match(listRes.stdout, new RegExp(type + '\\tfr\\thtml\\t\\d+'));
  });

  it('[MC05] templates delete removes the targeted row only', async () => {
    const type = 'del-' + cuid();
    await platformDB.setMailTemplate(type, 'en', 'subject', 'S');
    await platformDB.setMailTemplate(type, 'en', 'html', 'H');
    const delRes = runCli(['templates', 'delete', type, 'en', 'subject']);
    assert.strictEqual(delRes.status, 0, delRes.stderr);
    assert.strictEqual(await platformDB.getMailTemplate(type, 'en', 'subject'), null);
    assert.strictEqual(await platformDB.getMailTemplate(type, 'en', 'html'), 'H');
  });

  it('[MC06] templates delete without part wipes both html + subject for that lang', async () => {
    const type = 'del-lang-' + cuid();
    await platformDB.setMailTemplate(type, 'en', 'subject', 'S');
    await platformDB.setMailTemplate(type, 'en', 'html', 'H');
    await platformDB.setMailTemplate(type, 'fr', 'html', 'HF');
    const delRes = runCli(['templates', 'delete', type, 'en']);
    assert.strictEqual(delRes.status, 0, delRes.stderr);
    assert.strictEqual(await platformDB.getMailTemplate(type, 'en', 'subject'), null);
    assert.strictEqual(await platformDB.getMailTemplate(type, 'en', 'html'), null);
    assert.strictEqual(await platformDB.getMailTemplate(type, 'fr', 'html'), 'HF');
  });

  it('[MC07] templates seed --from overwrites rows from disk', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mail-seed-cli-'));
    const type = 'seed-' + cuid();
    const writeAt = async (rel, content) => {
      const full = path.join(dir, rel);
      await fs.mkdir(path.dirname(full), { recursive: true });
      await fs.writeFile(full, content, 'utf8');
    };
    await writeAt(type + '/en/subject.pug', '| from-disk');
    await writeAt(type + '/en/html.pug', 'p disk html');

    // pre-existing row — seed should overwrite it (matches the CLI contract).
    await platformDB.setMailTemplate(type, 'en', 'subject', 'legacy');

    const res = runCli(['templates', 'seed', '--from', dir]);
    assert.strictEqual(res.status, 0, res.stderr);
    assert.match(res.stdout, /seeded 2 row/);
    assert.strictEqual(await platformDB.getMailTemplate(type, 'en', 'subject'), '| from-disk');

    await fs.rm(dir, { recursive: true, force: true });
  });

  it('[MC08] templates get on missing row exits non-zero with a diagnostic', () => {
    const type = 'missing-' + cuid();
    const res = runCli(['templates', 'get', type, 'en', 'subject']);
    assert.notStrictEqual(res.status, 0);
    assert.match(res.stderr, /no row for/);
  });

  it('[MC09] templates set without --file is rejected', () => {
    const res = runCli(['templates', 'set', 'welcome', 'en', 'subject']);
    assert.notStrictEqual(res.status, 0);
    assert.match(res.stderr, /--file <path> is required/);
  });
});
