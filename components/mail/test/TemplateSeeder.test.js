/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

const assert = require('node:assert');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');

require('test-helpers/src/api-server-tests-config');

const { seedIfEmpty } = require('../src/TemplateSeeder');

function fakePlatformDB () {
  const rows = new Map();
  return {
    rows,
    async setMailTemplate (type, lang, part, pug) { rows.set(`${type}/${lang}/${part}`, pug); },
    async getAllMailTemplates () {
      return [...rows.entries()].map(([k, pug]) => {
        const [type, lang, part] = k.split('/');
        return { type, lang, part, pug };
      });
    }
  };
}

async function makeTemplatesDir () {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mail-seeder-'));
  const write = async (rel, content) => {
    const full = path.join(dir, rel);
    await fs.mkdir(path.dirname(full), { recursive: true });
    await fs.writeFile(full, content, 'utf8');
  };
  await write('welcome-email/en/subject.pug', '| Welcome');
  await write('welcome-email/en/html.pug', 'p Hello #{username}.');
  await write('welcome-email/fr/subject.pug', '| Bienvenue');
  await write('welcome-email/fr/html.pug', 'p Bonjour #{username}.');
  await write('reset-password/en/subject.pug', '| Reset');
  await write('reset-password/en/html.pug', 'p Token #{token}');
  return dir;
}

describe('[MAILSEED] TemplateSeeder', () => {
  let templatesRootDir;

  before(async () => { templatesRootDir = await makeTemplatesDir(); });
  after(async () => { await fs.rm(templatesRootDir, { recursive: true, force: true }); });

  it('[MSEED1] seeds every .pug file under <root>/<type>/<lang>/ into PlatformDB', async () => {
    const platformDB = fakePlatformDB();
    const result = await seedIfEmpty({ platformDB, templatesRootDir });
    assert.strictEqual(result.seeded, true);
    assert.strictEqual(result.count, 6);
    assert.strictEqual(platformDB.rows.get('welcome-email/en/subject'), '| Welcome');
    assert.strictEqual(platformDB.rows.get('welcome-email/fr/html'), 'p Bonjour #{username}.');
    assert.strictEqual(platformDB.rows.get('reset-password/en/subject'), '| Reset');
  });

  it('[MSEED2] is a no-op when PlatformDB already holds mail-template rows', async () => {
    const platformDB = fakePlatformDB();
    platformDB.rows.set('pre-existing/en/subject', '| already-here');
    const result = await seedIfEmpty({ platformDB, templatesRootDir });
    assert.strictEqual(result.seeded, false);
    assert.strictEqual(result.reason, 'already-seeded');
    assert.strictEqual(platformDB.rows.size, 1, 'no new rows added');
  });

  it('[MSEED3] skips with reason when templatesRootDir is not set', async () => {
    const platformDB = fakePlatformDB();
    const result = await seedIfEmpty({ platformDB, templatesRootDir: null });
    assert.strictEqual(result.seeded, false);
    assert.strictEqual(result.reason, 'templatesRootDir-not-set');
  });

  it('[MSEED4] skips with reason when templatesRootDir is missing on disk', async () => {
    const platformDB = fakePlatformDB();
    const result = await seedIfEmpty({
      platformDB,
      templatesRootDir: '/tmp/does-not-exist-' + Date.now()
    });
    assert.strictEqual(result.seeded, false);
    assert.strictEqual(result.reason, 'root-unreadable');
  });
});
