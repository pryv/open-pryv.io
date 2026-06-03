/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */


import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

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

const { Sender } = require('./Sender.ts');
const { TemplateRepository } = require('./TemplateRepository.ts');
const { createEmailTemplatesDelivery } = require('./emailTemplatesDelivery.ts');
const errors = require('./errors.ts');

const { getLogger } = require('@pryv/boiler');
const logger = getLogger('mail');

type Delivery = {
  templateExists: (type: string, lang: string) => boolean;
  refresh: () => Promise<void>;
  close: () => Promise<void>;
  tmpDir: string;
};
type TemplateRepositoryLike = { find: (type: string, lang: string) => Promise<unknown> };
type SenderLike = { renderAndSend: (template: unknown, substitutions: Record<string, unknown>, recipient: Recipient) => Promise<unknown> };
type MailState = { delivery: Delivery; templateRepository: TemplateRepositoryLike; sender: SenderLike };
type Recipient = { email: string; name?: string; type?: string };
type MailInitOpts = {
  getAllMailTemplates: () => Promise<unknown>;
  smtp: { host?: string; [k: string]: unknown };
  from?: string;
  defaultLang?: string;
  tmpDirRoot?: string;
};
type SendParams = {
  type: string;
  lang?: string;
  recipient: Recipient;
  substitutions?: Record<string, unknown>;
};
type IpcMessage = { type?: string; [k: string]: unknown };
type IpcListener = (msg: IpcMessage) => void;

let state: MailState | null = null;
let ipcListener: IpcListener | null = null;

async function init (opts: MailInitOpts): Promise<void> {
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

  const delivery: Delivery = await createEmailTemplatesDelivery({ getAllMailTemplates, smtp, from, tmpDirRoot });
  const templateRepository: TemplateRepositoryLike = new TemplateRepository(defaultLang, delivery.templateExists);
  const sender: SenderLike = new Sender(delivery);

  state = { delivery, templateRepository, sender };

  // Cluster workers: subscribe to master's `mail:template-invalidate` broadcast
  // so the local tmp-dir is re-materialised from PlatformDB right after any
  // admin-API PUT/DELETE on this core. Other cores pick up the same row
  // change via rqlite replication + their master's periodic refresh.
  if (typeof process.send === 'function') {
    ipcListener = (msg: IpcMessage) => {
      if (msg && msg.type === 'mail:template-invalidate') {
        refresh().catch((err: Error) => {
          logger.warn('mail:template-invalidate refresh failed: ' + err.message);
        });
      }
    };
    process.on('message', ipcListener);
  }

  logger.info(`ready (defaultLang=${defaultLang}, tmpDir=${delivery.tmpDir})`);
}

function isActive (): boolean {
  return state != null;
}

async function send ({ type, lang, recipient, substitutions }: SendParams): Promise<{ sent: boolean; skipped?: string; result?: unknown }> {
  if (!state) return { sent: false, skipped: 'not-active' };
  if (!type || !recipient || !recipient.email) {
    throw errors.invalidRequestStructure('send: { type, recipient.email } are required');
  }
  const template = await state.templateRepository.find(type, lang || 'en');
  const result = await state.sender.renderAndSend(template, substitutions || {}, recipient);
  return { sent: true, result };
}

async function refresh (): Promise<void> {
  if (!state) return;
  await state.delivery.refresh();
  logger.info('templates refreshed from PlatformDB');
}

async function close (): Promise<void> {
  if (ipcListener != null) {
    try { process.off('message', ipcListener); } catch (_) { /* never attached */ }
    ipcListener = null;
  }
  if (!state) return;
  await state.delivery.close();
  state = null;
}

// Exposed for tests + admin-surface consumers.
const _internal = {
  get state () { return state; }
};

export { init, isActive, send, refresh, close, _internal };
