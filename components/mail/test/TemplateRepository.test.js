/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

const assert = require('node:assert');

require('test-helpers/src/api-server-tests-config');

const { TemplateRepository } = require('../src/TemplateRepository');

function existsFn (availablePaths) {
  const set = new Set(availablePaths);
  return async (p) => set.has(p);
}

describe('[MAILREPO] TemplateRepository', () => {
  it('[MREP1] returns the requested-language template when available', async () => {
    const repo = new TemplateRepository('en', existsFn([
      'welcome-email/fr/subject.pug', 'welcome-email/fr/html.pug'
    ]));
    const t = await repo.find('welcome-email', 'fr');
    assert.strictEqual(t.root, 'welcome-email/fr');
  });

  it('[MREP2] falls back to the default language when the requested one is missing', async () => {
    const repo = new TemplateRepository('en', existsFn([
      'welcome-email/en/subject.pug', 'welcome-email/en/html.pug'
    ]));
    const t = await repo.find('welcome-email', 'zh'); // zh missing → fall back to en
    assert.strictEqual(t.root, 'welcome-email/en');
  });

  it('[MREP3] throws unknownResource when neither requested nor default exists', async () => {
    const repo = new TemplateRepository('en', existsFn([]));
    await assert.rejects(
      () => repo.find('welcome-email', 'fr'),
      (err) => err.id === 'unknown-resource' && err.httpStatus === 404
    );
  });

  it('[MREP4] accepts a null requestedLanguage and resolves via default', async () => {
    const repo = new TemplateRepository('en', existsFn([
      'reset-password/en/subject.pug', 'reset-password/en/html.pug'
    ]));
    const t = await repo.find('reset-password', null);
    assert.strictEqual(t.root, 'reset-password/en');
  });
});
