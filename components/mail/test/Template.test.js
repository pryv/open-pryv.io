/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

const assert = require('node:assert');

require('test-helpers/src/api-server-tests-config');

const { Template } = require('../src/Template');

describe('[MAILTMPL] Template', () => {
  it('[MTPL1] exists() returns true only when both subject.pug and html.pug exist', async () => {
    const paths = [];
    const t = new Template('welcome-email', 'en', async (p) => {
      paths.push(p);
      return true;
    });
    assert.strictEqual(await t.exists(), true);
    assert.deepStrictEqual(paths, ['welcome-email/en/subject.pug', 'welcome-email/en/html.pug']);
  });

  it('[MTPL2] exists() returns false on first-missing-part and short-circuits the second probe', async () => {
    const calls = [];
    const t = new Template('welcome-email', 'fr', async (p) => {
      calls.push(p);
      return p.endsWith('html.pug'); // only html exists, subject does not
    });
    assert.strictEqual(await t.exists(), false);
    assert.strictEqual(calls.length, 1, 'should stop probing after first missing part');
    assert.strictEqual(calls[0], 'welcome-email/fr/subject.pug');
  });

  it('[MTPL3] executeSend delegates to sendOp.sendMail with the template root', async () => {
    let got;
    const sendOp = { sendMail: async (root) => { got = root; return { sent: true }; } };
    const t = new Template('reset-password', 'de', async () => true);
    const res = await t.executeSend(sendOp);
    assert.strictEqual(got, 'reset-password/de');
    assert.deepStrictEqual(res, { sent: true });
  });
});
