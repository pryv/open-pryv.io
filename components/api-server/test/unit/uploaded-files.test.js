/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

require('test-helpers/src/api-server-tests-config.ts');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

// An upload descriptor is opened only when its path is a regular file named
// like the upload parser names them (32 lowercase hex characters) directly
// inside the upload temp directory; its size is the size on disk.
describe('[UPFC] uploaded file containment', function () {
  let openUploadedFile, getUploadTempDir;
  const created = [];
  let outsideDir;

  function hexName () { return crypto.randomBytes(16).toString('hex'); }
  function track (p) { created.push(p); return p; }

  before(function () {
    ({ openUploadedFile, getUploadTempDir } = require('../../src/methods/helpers/uploadedFiles.ts'));
    outsideDir = track(fs.mkdtempSync(path.join(os.tmpdir(), 'upfc-')));
  });
  after(function () {
    for (const p of created.reverse()) fs.rmSync(p, { recursive: true, force: true });
  });

  async function assertRefused (file) {
    await assert.rejects(openUploadedFile(file), (err) => {
      assert.strictEqual(err.id, 'invalid-parameters-format');
      return true;
    });
  }

  it('[UPFC1] the upload temp directory is the operating system temp directory', function () {
    assert.strictEqual(getUploadTempDir(), path.resolve(os.tmpdir()));
  });

  it('[UPFC2] opens a regular file with a 32-hex name in the upload directory, size from disk', async function () {
    const content = Buffer.from('upfc2-' + hexName());
    const p = track(path.join(os.tmpdir(), hexName()));
    fs.writeFileSync(p, content);
    const { stream, size } = await openUploadedFile({ path: p, size: 1 });
    assert.strictEqual(size, content.length, 'size is taken from the file, not the descriptor');
    const chunks = [];
    for await (const c of stream) chunks.push(c);
    assert.ok(Buffer.concat(chunks).equals(content));
  });

  it('[UPFC3] refuses a file outside the upload directory', async function () {
    const p = track(path.join(outsideDir, hexName()));
    fs.writeFileSync(p, 'outside');
    await assertRefused({ path: p, size: 7 });
  });

  it('[UPFC4] refuses a path that climbs out of the upload directory', async function () {
    const name = hexName();
    const parentFile = path.join(path.dirname(path.resolve(os.tmpdir())), name);
    await assertRefused({ path: os.tmpdir() + path.sep + '..' + path.sep + name, size: 1 });
    await assertRefused({ path: parentFile, size: 1 });
    await assertRefused({ path: path.join(os.tmpdir(), path.basename(outsideDir), '..', '..', 'etc', name), size: 1 });
  });

  it('[UPFC5] refuses a symlink in the upload directory pointing outside', async function () {
    const target = track(path.join(outsideDir, 'target.txt'));
    fs.writeFileSync(target, 'target');
    const link = track(path.join(os.tmpdir(), hexName()));
    fs.symlinkSync(target, link);
    await assertRefused({ path: link, size: 6 });
  });

  it('[UPFC6] refuses a file whose name is not 32 lowercase hex characters', async function () {
    for (const name of ['upfc-' + hexName(), hexName().slice(1), hexName().toUpperCase(), hexName() + '.txt']) {
      const p = track(path.join(os.tmpdir(), name));
      fs.writeFileSync(p, 'x');
      await assertRefused({ path: p, size: 1 });
    }
  });

  it('[UPFC7] refuses something that is not a regular file, or no path at all', async function () {
    const dir = track(path.join(os.tmpdir(), hexName()));
    fs.mkdirSync(dir);
    await assertRefused({ path: dir, size: 1 });
    await assertRefused({ path: path.join(os.tmpdir(), hexName()), size: 1 }); // absent
    await assertRefused({ size: 1 });
    await assertRefused({ path: 42 });
    await assertRefused(null);
  });
});
