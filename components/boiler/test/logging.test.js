/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { inspectAndHide, getLogger, setGlobalName } from '../src/logging.ts';

const TOKEN = 'ckzq8x4k2b7c9d0e1f2g3h4i5j';
const LOGGING_SRC = fileURLToPath(new URL('../src/logging.ts', import.meta.url));

describe('[BLGM] boiler logging masks credentials', function () {
  it('[BLGM1] an Error is masked: message, stack, fields and cause, and stays an Error', function () {
    const cause = new Error('upstream refused https://' + TOKEN + '@core.example.com/');
    const err = new Error('call to https://' + TOKEN + '@core.example.com/events?auth=' + TOKEN + ' failed', { cause });
    err.detail = 'retry with "accessToken":"' + TOKEN + '"';
    err.token = TOKEN;
    err.data = { userId: 'u1', readToken: TOKEN, keep: 'visible' };
    err.statusCode = 503;
    const masked = inspectAndHide(err);
    assert.ok(masked instanceof Error, 'printed as an Error, with its stack');
    const shown = JSON.stringify({ message: masked.message, stack: masked.stack, fields: masked, cause: masked.cause?.message, causeStack: masked.cause?.stack });
    assert.ok(!shown.includes(TOKEN), shown);
    assert.match(masked.message, /^call to https:\/\/\(hidden\)@core\.example\.com\/events\?auth=\(hidden\) failed$/);
    assert.strictEqual(masked.statusCode, 503);
    assert.strictEqual(masked.data.keep, 'visible');
    assert.strictEqual(masked.data.userId, 'u1');
    assert.strictEqual(masked.token, '(hidden)');
    assert.ok(masked.stack.includes('logging.test.js'), 'the stack trace stays readable');
    assert.strictEqual(err.token, TOKEN, 'the logged Error itself is left untouched');
  });

  it('[BLGM2] credential key names are hidden, other values are kept', function () {
    const masked = inspectAndHide({
      key: TOKEN,
      readToken: TOKEN,
      passphrase: TOKEN,
      adminAccessKey: TOKEN,
      access_token: TOKEN,
      refresh_token: TOKEN,
      client_secret: TOKEN,
      code_verifier: TOKEN,
      cookie: TOKEN,
      piiHmacKey: TOKEN,
      code: 'ECONNREFUSED',
      username: 'alice'
    });
    assert.ok(!JSON.stringify(masked).includes(TOKEN), JSON.stringify(masked));
    assert.strictEqual(masked.code, 'ECONNREFUSED');
    assert.strictEqual(masked.username, 'alice');
  });

  it('[BLGM3] credentials in a URL (user info) are hidden, the rest of the URL is kept', function () {
    const masked = inspectAndHide({
      apiEndpoint: 'https://' + TOKEN + '@alice.example.com/',
      note: 'peer at https://admin:' + TOKEN + '@core-b.example.com:443/system/x said no',
      email: 'alice@example.com'
    });
    assert.strictEqual(masked.apiEndpoint, 'https://(hidden)@alice.example.com/');
    assert.strictEqual(masked.note, 'peer at https://(hidden)@core-b.example.com:443/system/x said no');
    assert.strictEqual(masked.email, 'alice@example.com');
  });

  it('[BLGM4] debug output (DEBUG=pryv:*) is masked like the other levels', function () {
    setGlobalName('blgm');
    const logger = getLogger('blgm4');
    const printed = [];
    logger.debugInstance = Object.assign((...args) => printed.push(args), { enabled: true });
    logger.debug('handleMessage', 'user1', { action: 'unset-access-logic', accessId: 'a1', accessToken: TOKEN });
    logger.debug('GET /u/events?auth=' + TOKEN);
    assert.strictEqual(printed.length, 2);
    assert.ok(!JSON.stringify(printed).includes(TOKEN), JSON.stringify(printed));
    assert.strictEqual(printed[0][2].accessId, 'a1', 'the rest of the message stays readable');
  });

  it('[BLGM6] an Error field that cannot be masked (circular) is left out, not printed as is', function () {
    const request = { headers: { authorization: TOKEN }, url: '/u/events' };
    request.self = request;
    const err = new Error('request failed');
    err.request = request;
    err.status = 502;
    const masked = inspectAndHide(err);
    assert.strictEqual(masked.request, '(not logged)');
    assert.strictEqual(masked.status, 502);
  });

  it('[BLGM5] an Error inside a logged object keeps its masked message', function () {
    const masked = inspectAndHide({ step: 'sync', err: new Error('refused for https://' + TOKEN + '@h.example.com/') });
    assert.strictEqual(masked.step, 'sync');
    assert.strictEqual(masked.err.message, 'refused for https://(hidden)@h.example.com/');
  });
});

describe('[BLFM] boiler log file modes', function () {
  this.timeout(30000);
  let dir;
  before(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'blfm-')); });
  after(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  function mode (p) { return (fs.statSync(p).mode & 0o777).toString(8); }

  // Boots the logger (initLoggerWithConfig) in a fresh process with these
  // logs settings, writes one error entry and exits.
  function bootLoggerAndLog (logs) {
    const values = {
      'logs:console': { active: false, level: 'info', format: {} },
      'logs:console:active': false,
      'logs:file': logs.file,
      'logs:file:active': logs.file != null,
      'logs:fileSync': logs.fileSync,
      'logs:custom:active': false,
      'logs:skipUncaughtException': true
    };
    const script = [
      `const logging = await import(${JSON.stringify(LOGGING_SRC)});`,
      "logging.setGlobalName('blfm');",
      'const values = JSON.parse(process.env.BLFM_VALUES);',
      'await logging.initLoggerWithConfig({ get: (key) => values[key] });',
      "logging.getLogger('blfm').error('blfm entry');",
      'setTimeout(() => process.exit(0), 700);'
    ].join('\n');
    const res = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
      env: Object.assign({}, process.env, { BLFM_VALUES: JSON.stringify(values) }),
      encoding: 'utf8',
      timeout: 20000
    });
    assert.strictEqual(res.status, 0, res.stdout + res.stderr);
  }

  it('[BLFM1] log files are created 0640 in directories created 0750 (plain, rotated and sync files)', function () {
    const umask = process.umask();
    const plainDir = path.join(dir, 'plain', 'logs');
    const rotatedDir = path.join(dir, 'rotated', 'logs');
    const syncDir = path.join(dir, 'sync', 'logs');
    bootLoggerAndLog({
      file: { path: path.join(plainDir, 'core.log'), level: 'info', rotation: { isActive: false } },
      fileSync: { active: true, path: path.join(syncDir, 'core-sync.log'), level: 'warn' }
    });
    bootLoggerAndLog({
      file: { path: path.join(rotatedDir, 'core.log'), level: 'info', rotation: { isActive: true, days: 2 } }
    });
    const rotatedFiles = fs.readdirSync(rotatedDir).filter((n) => n.startsWith('core.log.') && !n.endsWith('.gz'));
    assert.ok(rotatedFiles.length > 0, 'a rotated log file was written: ' + fs.readdirSync(rotatedDir));

    const fileMode = (0o640 & ~umask).toString(8);
    const dirMode = (0o750 & ~umask).toString(8);
    assert.strictEqual(mode(path.join(plainDir, 'core.log')), fileMode, 'plain log file');
    assert.strictEqual(mode(path.join(syncDir, 'core-sync.log')), fileMode, 'sync log file');
    for (const f of rotatedFiles) assert.strictEqual(mode(path.join(rotatedDir, f)), fileMode, f);
    for (const d of [plainDir, rotatedDir, syncDir]) assert.strictEqual(mode(d), dirMode, d);
  });
});
