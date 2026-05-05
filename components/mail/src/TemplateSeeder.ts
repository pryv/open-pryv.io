/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */


import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

/**
 * One-shot bootstrap helper: when PlatformDB has no mail templates yet,
 * walk an on-disk Pug directory and load every template file into
 * PlatformDB under the `mail-template/<type>/<lang>/<part>` keyspace.
 *
 * Directory shape expected (same as the standalone service-mail ships):
 *     <rootDir>/<type>/<lang>/subject.pug
 *     <rootDir>/<type>/<lang>/html.pug
 *
 * Idempotent: if any `mail-template/*` row already exists, the seeder
 * is a no-op. Re-seeding after the first boot is the job of the admin
 * CLI / admin API that ships in a later slice.
 */

const fs = require('node:fs/promises');
const path = require('node:path');

const { getLogger } = require('@pryv/boiler');
const logger = getLogger('mail-template-seeder');

/**
 * @param {object} opts
 * @param {object} opts.platformDB     — the PlatformDB instance (setMailTemplate + getAllMailTemplates)
 * @param {string} opts.templatesRootDir — absolute path to the Pug root
 * @returns {Promise<{ seeded: boolean, count: number, reason?: string }>}
 */
async function seedIfEmpty ({ platformDB, templatesRootDir }) {
  if (!platformDB) throw new Error('TemplateSeeder: platformDB is required');
  if (!templatesRootDir) {
    return { seeded: false, count: 0, reason: 'templatesRootDir-not-set' };
  }

  const existing = await platformDB.getAllMailTemplates();
  if (existing.length > 0) {
    logger.debug(`PlatformDB already holds ${existing.length} mail-template row(s); skipping seed`);
    return { seeded: false, count: existing.length, reason: 'already-seeded' };
  }

  try {
    await fs.access(templatesRootDir);
  } catch (_) {
    logger.warn(`templatesRootDir '${templatesRootDir}' is not readable; skipping seed`);
    return { seeded: false, count: 0, reason: 'root-unreadable' };
  }

  let count = 0;
  for (const type of await listDirs(templatesRootDir)) {
    const typeDir = path.join(templatesRootDir, type);
    for (const lang of await listDirs(typeDir)) {
      const langDir = path.join(typeDir, lang);
      const files = await fs.readdir(langDir);
      for (const file of files) {
        if (!file.endsWith('.pug')) continue;
        const part = file.replace(/\.pug$/, '');
        const pug = await fs.readFile(path.join(langDir, file), 'utf8');
        await platformDB.setMailTemplate(type, lang, part, pug);
        count++;
      }
    }
  }
  logger.info(`seeded ${count} mail-template row(s) from ${templatesRootDir}`);
  return { seeded: true, count };
}

async function listDirs (parent) {
  const entries = await fs.readdir(parent, { withFileTypes: true });
  return entries.filter(e => e.isDirectory()).map(e => e.name);
}

export { seedIfEmpty };
