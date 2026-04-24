/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/**
 * In-process mail façade.
 *
 * Shape:
 *   - `init(opts)` wires the delivery adapter + repository on first call.
 *     Must be called from master/worker boot once `services.email.method`
 *     is `'in-process'` and PlatformDB is ready.
 *   - `isActive()` true only after a successful init.
 *   - `send({ type, lang, recipient, substitutions })` renders + delivers.
 *     Silent no-op (returns `{ sent: false, skipped: 'not-active' }`) when
 *     the module wasn't initialised — callers don't need to guard.
 *   - `refresh()` re-materialises the tmp template dir from PlatformDB
 *     (admin CLI / admin API write path calls this on invalidation).
 *
 * Phase A scope: façade + ports only. Callers still go through the
 * microservice HTTP path; flipping `services.email.method` to `in-process`
 * lands in a later phase once PlatformDB template wiring + the admin
 * surface ship.
 */

const Sender = require('./Sender');
const TemplateRepository = require('./TemplateRepository');
const { createEmailTemplatesDelivery } = require('./emailTemplatesDelivery');
const errors = require('./errors');

const { getLogger } = require('@pryv/boiler');
const logger = getLogger('mail');

let state = null;

async function init (opts) {
  if (state) {
    logger.warn('mail.init called twice — ignoring');
    return;
  }
  const {
    getAllMailTemplates,
    smtp,
    from,
    defaultLang = 'en',
    tmpDirRoot
  } = opts || {};

  const delivery = await createEmailTemplatesDelivery({ getAllMailTemplates, smtp, from, tmpDirRoot });
  const templateRepository = new TemplateRepository(defaultLang, delivery.templateExists);
  const sender = new Sender(delivery);

  state = { delivery, templateRepository, sender };
  logger.info(`ready (defaultLang=${defaultLang}, tmpDir=${delivery.tmpDir})`);
}

function isActive () {
  return state != null;
}

async function send ({ type, lang, recipient, substitutions }) {
  if (!state) return { sent: false, skipped: 'not-active' };
  if (!type || !recipient || !recipient.email) {
    throw errors.invalidRequestStructure('send: { type, recipient.email } are required');
  }
  const template = await state.templateRepository.find(type, lang);
  const result = await state.sender.renderAndSend(template, substitutions || {}, recipient);
  return { sent: true, result };
}

async function refresh () {
  if (!state) return;
  await state.delivery.refresh();
  logger.info('templates refreshed from PlatformDB');
}

async function close () {
  if (!state) return;
  await state.delivery.close();
  state = null;
}

module.exports = {
  init,
  isActive,
  send,
  refresh,
  close,
  // Exposed for tests + admin-surface consumers.
  _internal: {
    get state () { return state; }
  }
};
