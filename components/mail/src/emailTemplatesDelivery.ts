/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */


import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const EmailTemplates = require('email-templates');

const { getLogger } = require('@pryv/boiler');
const logger = getLogger('mail-delivery');

/**
 * Adapter that makes the `email-templates` npm module (on-disk Pug renderer)
 * read from PlatformDB instead. Strategy: materialize the PlatformDB rows to
 * a process-local tmp directory on init, instantiate `email-templates` with
 * `views.root` pointing at that tmp dir, and re-materialize on demand when
 * templates change.
 *
 * This avoids forking `email-templates` while still keeping PlatformDB as
 * the authoritative template store cluster-wide.
 *
 * @param {object} opts
 * @param {Function} opts.getAllMailTemplates   async () → Array<{ type, lang, part, pug }>
 * @param {object}   opts.smtp                  nodemailer-compatible transport config
 * @param {object}   opts.from                  default `from` (name + address)
 * @param {string}   [opts.tmpDirRoot]          override tmpdir (tests)
 * @returns {Promise<{
 *   send: Function,
 *   templateExists: Function,
 *   refresh: Function,
 *   close: Function,
 *   tmpDir: string
 * }>}
 */
async function createEmailTemplatesDelivery (opts) {
  const { getAllMailTemplates, smtp, from } = opts;
  if (typeof getAllMailTemplates !== 'function') {
    throw new Error('emailTemplatesDelivery: getAllMailTemplates function is required');
  }
  if (!smtp) throw new Error('emailTemplatesDelivery: smtp transport config is required');

  const tmpDirRoot = opts.tmpDirRoot || os.tmpdir();
  const tmpDir = await fs.mkdtemp(path.join(tmpDirRoot, 'pryv-mail-'));
  logger.info(`materialising templates under ${tmpDir}`);

  await materialiseTemplates(tmpDir, getAllMailTemplates);

  const delivery = new EmailTemplates({
    message: { from: formatFrom(from) },
    views: { root: tmpDir },
    transport: smtp,
    preview: false,
    send: true
  });

  return {
    send: delivery.send.bind(delivery),
    templateExists: delivery.templateExists.bind(delivery),
    async refresh () {
      await clearDir(tmpDir);
      await materialiseTemplates(tmpDir, getAllMailTemplates);
    },
    async close () {
      await fs.rm(tmpDir, { recursive: true, force: true });
    },
    tmpDir
  };
}

/**
 * Walk the PlatformDB template rows and write them to disk mirroring the
 * `<type>/<lang>/<part>.pug` layout `email-templates` expects.
 */
async function materialiseTemplates (tmpDir, getAllMailTemplates) {
  const rows = await getAllMailTemplates();
  if (!Array.isArray(rows)) {
    throw new Error('emailTemplatesDelivery: getAllMailTemplates must return an array');
  }
  let count = 0;
  for (const row of rows) {
    if (!row || !row.type || !row.lang || !row.part || typeof row.pug !== 'string') {
      logger.warn('skipping malformed template row', { row });
      continue;
    }
    const dir = path.join(tmpDir, row.type, row.lang);
    await fs.mkdir(dir, { recursive: true });
    const filename = row.part.endsWith('.pug') ? row.part : `${row.part}.pug`;
    await fs.writeFile(path.join(dir, filename), row.pug, 'utf8');
    count++;
  }
  logger.debug(`materialised ${count} template file(s)`);
}

async function clearDir (dir) {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const e of entries) {
    await fs.rm(path.join(dir, e.name), { recursive: true, force: true });
  }
}

function formatFrom (from) {
  if (!from) return undefined;
  if (typeof from === 'string') return from;
  if (from.name && from.address) return `"${from.name}" <${from.address}>`;
  return from.address;
}

export { createEmailTemplatesDelivery };
