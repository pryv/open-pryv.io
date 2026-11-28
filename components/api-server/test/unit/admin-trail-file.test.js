/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

/**
 * [ATFP] the shell tools read the platform trail without creating its file:
 * with a storage of one file per account, an absent trail is reported (and
 * whether this process may create it), an existing one of this OS user opens.
 */
describe('[ATFP] platform trail file, as a shell tool sees it', function () {
  const { trailFileProblem } = require('api-server/src/methods/systemAdminAudit.ts');
  let dir;

  before(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atfp-')); });
  after(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  const storageAt = (file) => ({ existingPathForUser: () => file });

  it('[ATFP1] a database server: nothing to check', () => {
    assert.strictEqual(trailFileProblem({ forUser () {} }), null);
  });

  it('[ATFP2] never written: absent, creatable when the closest existing directory is this user\'s; nothing is created', () => {
    const file = path.join(dir, 'not', 'yet', 'audit.sqlite');
    assert.deepStrictEqual(trailFileProblem(storageAt(file)), { absent: true, creatable: true });
    assert.strictEqual(fs.existsSync(path.join(dir, 'not')), false, 'no directory created');
  });

  it('[ATFP3] an existing trail file of this user opens', () => {
    const file = path.join(dir, 'audit.sqlite');
    fs.writeFileSync(file, '');
    assert.strictEqual(trailFileProblem(storageAt(file)), null);
  });
});
