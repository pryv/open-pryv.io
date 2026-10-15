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
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { inspectAndHide, getLogger, setGlobalName } from '../src/logging.ts';

const TOKEN = 'ckzq8x4k2b7c9d0e1f2g3h4i5j';
const LOGGING_SRC = fileURLToPath(new URL('../src/logging.ts', import.meta.url));
const BOILER_SRC = fileURLToPath(new URL('../src/index.ts', import.meta.url));
const CONFIG_DIR = fileURLToPath(new URL('../../../config', import.meta.url));

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
  // logs settings, writes `count` error entries in a tight loop and exits.
  function bootLoggerAndLog (logs, count = 1) {
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
      `for (let i = 0; i < ${count}; i++) logging.getLogger('blfm').error('blfm entry ' + i);`,
      'setTimeout(() => process.exit(0), 1500);'
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

  // Every `blfm entry <i>` line found in the files of `logDir` (rotated files
  // may already be gzipped).
  function entriesIn (logDir) {
    const seen = new Set();
    for (const f of fs.readdirSync(logDir).filter((n) => n.startsWith('core.log'))) {
      const raw = fs.readFileSync(path.join(logDir, f));
      const text = (f.endsWith('.gz') ? zlib.gunzipSync(raw) : raw).toString('utf8');
      for (const line of text.split('\n')) {
        const m = /blfm entry (\d+)/.exec(line);
        if (m) seen.add(Number(m[1]));
      }
    }
    return seen;
  }

  it('[BLFS1] rotation.maxSize caps each file and loses no entry of a burst', function () {
    const logDir = path.join(dir, 'capped', 'logs');
    bootLoggerAndLog({
      file: { path: path.join(logDir, 'core.log'), level: 'info', rotation: { isActive: true, days: 2, maxSize: '1k' } }
    }, 300);
    // Split files, gzipped or not (a file closed in the tick it opened is not gzipped).
    const files = fs.readdirSync(logDir).filter((n) => n.startsWith('core.log.')).map((n) => n.replace(/\.gz$/, ''));
    assert.ok(new Set(files).size > 1, 'the size cap started new files: ' + files);
    assert.strictEqual(entriesIn(logDir).size, 300, 'every entry of the burst is in a file');
  });

  it('[BLFS2] without rotation, one file at the configured path holds every entry of a burst', function () {
    const logDir = path.join(dir, 'unrotated', 'logs');
    bootLoggerAndLog({
      file: { path: path.join(logDir, 'core.log'), level: 'info', rotation: { isActive: false } }
    }, 300);
    assert.deepStrictEqual(fs.readdirSync(logDir).filter((n) => n.startsWith('core.log')), ['core.log']);
    assert.strictEqual(entriesIn(logDir).size, 300);
  });
});

describe('[BLFB] boiler log fallback when no target is configured', function () {
  this.timeout(30000);
  let dir;
  before(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'blfb-')); });
  after(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  // Boots the logger with these logs settings (LOGS, LOG_FORMAT and DEBUG
  // unset unless given in `env`), writes one entry per level, then runs
  // `extra` (statements using `l`); returns what reached stdout and stderr.
  function bootAndLogEachLevel (values, { env: extraEnv = {}, extra = '' } = {}) {
    const script = [
      `const logging = await import(${JSON.stringify(LOGGING_SRC)});`,
      "logging.setGlobalName('blfb');",
      'const values = JSON.parse(process.env.BLFB_VALUES);',
      'await logging.initLoggerWithConfig({ get: (key) => values[key] });',
      "const l = logging.getLogger('blfb');",
      "l.debug('blfb-debug'); l.info('blfb-info'); l.warn('blfb-warn'); l.error('blfb-error');",
      extra,
      'setTimeout(() => process.exit(0), 1500);'
    ].join('\n');
    const env = Object.assign({}, process.env, { BLFB_VALUES: JSON.stringify(values) });
    delete env.LOGS;
    delete env.LOG_FORMAT;
    delete env.DEBUG;
    Object.assign(env, extraEnv);
    const res = spawnSync(process.execPath, ['--input-type=module', '-e', script], { env, encoding: 'utf8', timeout: 20000 });
    assert.strictEqual(res.status, 0, res.stdout + res.stderr);
    return res;
  }

  function silentConsole (extra) {
    return Object.assign({
      'logs:console': { active: false, level: 'info', format: {} },
      'logs:console:active': false,
      'logs:file:active': false,
      'logs:custom:active': false,
      'logs:skipUncaughtException': true
    }, extra);
  }

  it('[BLFB1] with no log target configured, warnings and errors go to stderr (and nothing below warn)', function () {
    const res = bootAndLogEachLevel(silentConsole());
    assert.match(res.stderr, /\[warn\]: \[blfb:blfb\] blfb-warn/);
    assert.match(res.stderr, /\[error\]: \[blfb:blfb\] blfb-error/);
    assert.doesNotMatch(res.stderr + res.stdout, /blfb-info|blfb-debug/);
    assert.doesNotMatch(res.stdout, /blfb-/);
  });

  it('[BLFB2] with a log file configured, a silent console stays silent', function () {
    const logPath = path.join(dir, 'fallback', 'logs', 'core.log');
    const res = bootAndLogEachLevel(silentConsole({
      'logs:file': { path: logPath, level: 'info', rotation: { isActive: false } },
      'logs:file:active': true
    }));
    assert.doesNotMatch(res.stderr + res.stdout, /blfb-/);
    assert.match(fs.readFileSync(logPath, 'utf8'), /blfb-error/);
  });

  it('[BLFB3] with only the sync file configured, a silent console stays silent', function () {
    const syncPath = path.join(dir, 'fallback-sync', 'logs', 'core-sync.log');
    const res = bootAndLogEachLevel(silentConsole({
      'logs:fileSync': { active: true, path: syncPath, level: 'warn' },
      'logs:fileSync:active': true
    }));
    assert.doesNotMatch(res.stderr + res.stdout, /blfb-/);
    assert.match(fs.readFileSync(syncPath, 'utf8'), /blfb-error/);
  });

  it('[BLFB4] an active console keeps its configured level and stream', function () {
    const res = bootAndLogEachLevel(silentConsole({
      'logs:console': { active: true, level: 'info', format: {} },
      'logs:console:active': true
    }));
    assert.match(res.stdout, /blfb-info/);
    assert.match(res.stdout, /blfb-error/);
    assert.doesNotMatch(res.stderr, /blfb-/);
  });

  it('[BLFB5] the fallback output carries no ANSI colour codes, even with a colour format', function () {
    const res = bootAndLogEachLevel(silentConsole({
      'logs:console': { active: false, level: 'info', format: { color: true, time: true } }
    }));
    assert.match(res.stderr, /blfb-error/);
    assert.ok(!res.stderr.includes('\u001b['), JSON.stringify(res.stderr));
  });

  it('[BLFB6] config/production-config.yml: the console output carries no ANSI colour codes', function () {
    const runDir = fs.mkdtempSync(path.join(dir, 'prod-'));
    const script = path.join(runDir, 'boot.mjs');
    fs.writeFileSync(script, [
      `const { init, getLogger } = await import(${JSON.stringify(BOILER_SRC)});`,
      `init({ appName: 'blfb', baseConfigDir: ${JSON.stringify(CONFIG_DIR)}, skipOverrideConfig: true });`,
      "const l = getLogger('prod');",
      "l.info('blfb-info', { nested: { list: [1, 'two'] } }); l.error('blfb-error', { code: 'E1' });",
      'setTimeout(() => process.exit(0), 1500);'
    ].join('\n'));
    const env = Object.assign({}, process.env);
    for (const k of ['LOGS', 'LOG_FORMAT', 'DEBUG', 'NODE_ENV']) delete env[k];
    const res = spawnSync(process.execPath, [script, '--config', path.join(CONFIG_DIR, 'production-config.yml')], {
      cwd: runDir, env, encoding: 'utf8', timeout: 20000
    });
    assert.strictEqual(res.status, 0, res.stdout + res.stderr);
    const out = res.stdout + res.stderr;
    assert.match(out, /blfb-info/);
    assert.match(out, /blfb-error/);
    assert.ok(!out.includes('\u001b['), JSON.stringify(out));
  });

  it('[BLFB7] with a custom logger configured, a silent console stays silent', function () {
    const customDir = fs.mkdtempSync(path.join(dir, 'custom-'));
    const customOut = path.join(customDir, 'custom.log');
    const customModule = path.join(customDir, 'custom-logger.cjs');
    fs.writeFileSync(customModule, [
      "const fs = require('node:fs');",
      'module.exports = {',
      '  init: async () => {},',
      `  log: (level, key, message) => fs.appendFileSync(${JSON.stringify(customOut)}, level + ' ' + message + '\\n')`,
      '};'
    ].join('\n'));
    const res = bootAndLogEachLevel(silentConsole({
      'logs:custom:active': true,
      'logs:custom:path': customModule,
      'logs:custom:settings': {}
    }));
    assert.doesNotMatch(res.stderr + res.stdout, /blfb-/);
    assert.match(fs.readFileSync(customOut, 'utf8'), /error blfb-error/);
  });

  it('[BLFB8] LOGS=<level> with no target keeps its console: stdout at that level, nothing on stderr', function () {
    const res = bootAndLogEachLevel(silentConsole(), { env: { LOGS: 'warn' } });
    assert.match(res.stdout, /\[warn\]: \[blfb:blfb\] blfb-warn/);
    assert.match(res.stdout, /\[error\]: \[blfb:blfb\] blfb-error/);
    assert.doesNotMatch(res.stdout, /blfb-info|blfb-debug/);
    assert.doesNotMatch(res.stderr, /blfb-/);
  });

  it('[BLFB9] LOG_FORMAT=json: an Error given as context keeps its masked message and stack', function () {
    const res = bootAndLogEachLevel(silentConsole(), {
      env: { LOG_FORMAT: 'json' },
      extra: `l.error('blfb-err-ctx', new Error('boom auth=${TOKEN}'));`
    });
    const line = res.stderr.split('\n').find((s) => s.includes('blfb-err-ctx'));
    assert.ok(line, res.stderr);
    const entry = JSON.parse(line);
    assert.strictEqual(entry.level, 'error');
    assert.strictEqual(entry.context.name, 'Error');
    assert.strictEqual(entry.context.message, 'boom auth=(hidden)');
    assert.match(entry.context.stack, /^Error: boom auth=\(hidden\)/);
    assert.ok(!line.includes(TOKEN), line);
  });

  it('[BLFB10] text format: an Error given as context prints its name, masked message and stack', function () {
    const res = bootAndLogEachLevel(silentConsole(), {
      extra: `l.error('blfb-err-ctx', new TypeError('boom auth=${TOKEN}'));`
    });
    const at = res.stderr.indexOf('blfb-err-ctx');
    assert.ok(at >= 0, res.stderr);
    const shown = res.stderr.slice(at);
    // The masked copy is an Error carrying the original name: `Error [TypeError]: …`.
    assert.match(shown, /^blfb-err-ctx Error \[TypeError\]: boom auth=\(hidden\)\n\s+at /);
    assert.ok(!res.stderr.includes(TOKEN), res.stderr);
    assert.ok(!/blfb-err-ctx \{\}/.test(res.stderr), res.stderr);
  });

  it('[BLFB11] log file: an Error given as context keeps its name, masked message and stack', function () {
    const logPath = path.join(dir, 'err-ctx', 'logs', 'core.log');
    bootAndLogEachLevel(silentConsole({
      'logs:file': { path: logPath, level: 'error', rotation: { isActive: false } },
      'logs:file:active': true
    }), { extra: `l.error('blfb-err-ctx', new TypeError('boom auth=${TOKEN}'));` });
    const line = fs.readFileSync(logPath, 'utf8').split('\n').find((s) => s.includes('blfb-err-ctx'));
    assert.ok(line);
    const entry = JSON.parse(line);
    assert.strictEqual(entry.context.name, 'TypeError');
    assert.strictEqual(entry.context.message, 'boom auth=(hidden)');
    assert.match(entry.context.stack, /^TypeError: boom auth=\(hidden\)\n\s+at /);
    assert.ok(!line.includes(TOKEN), line);
  });

  // The boiler config logs `get: [key] is undefined` at debug: read while the
  // logger is being set up, such a line used to reach winston before any
  // transport, which printed a "[winston] Attempt to write logs with no
  // transports" line at every process start.
  for (const [code, logsEnv] of [['BLFB12', null], ['BLFB13', 'debug']]) {
    it(`[${code}] a boiler boot ${logsEnv ? 'with LOGS=' + logsEnv : 'with no log target'} prints no winston warning`, function () {
      const runDir = fs.mkdtempSync(path.join(dir, 'boot-'));
      const script = path.join(runDir, 'boot.mjs');
      fs.writeFileSync(script, [
        `const { init, getLogger } = await import(${JSON.stringify(BOILER_SRC)});`,
        `init({ appName: 'blfb', baseConfigDir: ${JSON.stringify(CONFIG_DIR)}, skipOverrideConfig: true });`,
        "getLogger('boot').error('blfb-error');",
        'setTimeout(() => process.exit(0), 1500);'
      ].join('\n'));
      const env = Object.assign({}, process.env);
      for (const k of ['LOGS', 'LOG_FORMAT', 'DEBUG', 'NODE_ENV']) delete env[k];
      if (logsEnv) env.LOGS = logsEnv;
      const res = spawnSync(process.execPath, [script], { cwd: runDir, env, encoding: 'utf8', timeout: 20000 });
      assert.strictEqual(res.status, 0, res.stdout + res.stderr);
      const out = res.stdout + res.stderr;
      assert.match(out, /blfb-error/);
      assert.ok(!out.includes('[winston]'), out);
    });
  }
});
