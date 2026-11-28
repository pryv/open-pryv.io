/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
import { createRequire } from 'node:module';
import type { PryvRequest } from './_types.ts';
import type { Application, Response, NextFunction } from 'express';
import { isInProcessSmtpMissing } from 'business/src/emails/mailCapability.ts';
// `context` is attached by setMinimalMethodContext earlier in the chain.
const require = createRequire(import.meta.url);
const errors = require('errors').factory;
const Paths = require('./Paths.ts');
const methodCallback = require('./methodCallback.ts').default;
const contentType = require('middleware').contentType;
const { getLogger } = require('@pryv/boiler');
const { setMinimalMethodContext, setMethodId, adminAuth, adminLockdown } = require('middleware');
const { routeMatcher } = require('./system-permissions.ts');
const { redactUrl } = require('utils/src/redactUrl.ts');
const { coreIdProblem } = require('platform/src/coreIdentity.ts');
const { validateMailTemplate } = require('mail/src/templateValidator.ts');
const { USERNAME_REGEXP_STR, USERNAME_MIN_LENGTH, USERNAME_MAX_LENGTH } = require('../schema/helpers.ts');
const USERNAME_RE = new RegExp(USERNAME_REGEXP_STR);
const { adminRoute, digestOf, setAuditDetails } = require('../methods/helpers/adminAudit.ts');

function errMessage (err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** A short text from a request, for an audit record; anything else is left out. */
function shortText (v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 && v.length <= 256 ? v : undefined;
}

/**
 * What the record of an administration act served here names (see
 * methods/helpers/adminAudit.ts `adminRoute`): set by the handler, read once
 * the answer is sent. Never a secret, a body or a value of a unique field.
 */
function setAdminAct (res: Response, act: { target?: Record<string, string | undefined>; diff?: Record<string, unknown>; targetUserId?: string; targetAction?: string }): void {
  const next: Record<string, unknown> = Object.assign({}, res.locals.adminAct);
  if (act.target != null) {
    const target: Record<string, string> = {};
    for (const [k, v] of Object.entries(act.target)) if (v != null) target[k] = v;
    next.target = Object.keys(target).length > 0 ? target : undefined;
  }
  if (act.diff != null) next.diff = Object.assign({}, next.diff, act.diff);
  if (act.targetUserId != null) next.targetUserId = act.targetUserId;
  if (act.targetAction != null) next.targetAction = act.targetAction;
  res.locals.adminAct = next;
  // Also on the prepared record, so an error the error middleware records keeps the target.
  if (res.locals.adminContext != null) setAuditDetails(res.locals.adminContext, { target: next.target as Record<string, string> | undefined, diff: next.diff as Record<string, unknown> | undefined });
}

/** Whether the /system gate authenticated an administrator session (not the admin key, not a setup session). */
function isAdminSession (req: PryvRequest): boolean {
  return (req as PryvRequest & { adminSubject?: { kind?: string } }).adminSubject?.kind === 'session';
}

/** The account an act changed, when it is on this core: the act is also recorded in its own trail. */
async function noteTargetAccount (res: Response, username: unknown, action: string): Promise<void> {
  if (typeof username !== 'string') return;
  try {
    const { getUsersRepository } = require('business/src/users/index.ts');
    const userId = await (await getUsersRepository()).getUserIdForUsername(username);
    if (userId != null) setAdminAct(res, { targetUserId: userId, targetAction: action });
  } catch (_e) { /* not an account of this core */ }
}

// System (e.g. registration server) calls route handling.
export default function system (expressApp: Application, app: { systemAPI: { call: (...args: unknown[]) => unknown }; config: { get: (key: string) => unknown } }) {
  const systemAPI = app.systemAPI;
  const config = app.config;
  const logger = getLogger('routes:system');
  /**
   * The gate of every /system/* route (middleware/src/adminAuth.ts): the admin
   * key, an administrator session or a setup session, checked against the
   * route's entry in system-permissions.ts; the routes with their own
   * credential (bootstrap ack, personal-token routes) or none go through. Any
   * refusal answers 404. Then the lockdown (middleware/src/adminLockdown.ts)
   * refuses the writes this core marks as managed elsewhere.
   */
  const matchRoute = routeMatcher();
  const ruleOf = (method: string, path: string) => matchRoute(method, path)?.rule ?? null;
  expressApp.all(Paths.System + '/*', setMinimalMethodContext, adminAuth({
    rule: ruleOf,
    config,
    store: () => require('storages').platformDB,
    onRefused: (req: PryvRequest, reason: string) => {
      // No headers nor body in the log: a near-miss admin key or a client's
      // own token sent here by mistake would land in it.
      logger.warn('Unauthorized attempt to access system route', { url: redactUrl(req.url), ip: req.ip, reason });
    }
  }), adminLockdown({ rule: ruleOf, config }));
  expressApp.post(Paths.System + '/create-user', contentType.json, setMethodId('system.createUser'), createUser);
  function createUser (req: PryvRequest, res: Response, next: NextFunction) {
    const params = Object.assign({}, req.body);
    systemAPI.call(req.context, params, methodCallback(res, next, 201));
  }
  expressApp.get(Paths.System + '/user-info/:username', setMethodId('system.getUserInfo'), function (req: PryvRequest, res: Response, next: NextFunction) {
    const params = {
      username: req.params.username
    };
    systemAPI.call(req.context, params, methodCallback(res, next, 200));
  });
  expressApp.delete(Paths.System + '/users/:username/mfa', setMethodId('system.deactivateMfa'), function (req: PryvRequest, res: Response, next: NextFunction) {
    systemAPI.call(req.context, { username: req.params.username }, methodCallback(res, next, 204));
  });
  // Resolve a bare accessId -> its owning user + operational metadata, for
  // breach scoping (admin-key gated by the /system/* guard above). The
  // responder typically holds only a compromised accessId and no username.
  expressApp.get(Paths.System + '/accesses/:accessId', setMethodId('system.getAccess'), function (req: PryvRequest, res: Response, next: NextFunction) {
    systemAPI.call(req.context, { accessId: req.params.accessId }, methodCallback(res, next, 200));
  });
  // --------------------- admin user listing ----------------- //
  // Optional paging: ?limit&skip&search (prefix of the username).
  expressApp.get(Paths.System + '/admin/users', setMethodId('system.listUsers'), function (req: PryvRequest, res: Response, next: NextFunction) {
    const params: Record<string, unknown> = {};
    for (const key of ['limit', 'skip', 'search']) {
      if (req.query[key] != null) params[key] = req.query[key];
    }
    systemAPI.call(req.context, params, methodCallback(res, next, 200));
  });
  // --------------------- admin cores listing ----------------- //
  expressApp.get(Paths.System + '/admin/cores', setMethodId('system.listCores'), function (req: PryvRequest, res: Response, next: NextFunction) {
    systemAPI.call(req.context, {}, methodCallback(res, next, 200));
  });
  // --------------------- external-id namespaces ----------------- //
  expressApp.get(Paths.System + '/admin/ext-id-ns', setMethodId('system.extIdNamespaces.list'), function (req: PryvRequest, res: Response, next: NextFunction) {
    systemAPI.call(req.context, {}, methodCallback(res, next, 200));
  });
  expressApp.get(Paths.System + '/admin/ext-id-ns/:namespace', setMethodId('system.extIdNamespaces.get'), function (req: PryvRequest, res: Response, next: NextFunction) {
    systemAPI.call(req.context, { namespace: req.params.namespace }, methodCallback(res, next, 200));
  });
  expressApp.put(Paths.System + '/admin/ext-id-ns/:namespace', contentType.json, setMethodId('system.extIdNamespaces.set'), function (req: PryvRequest, res: Response, next: NextFunction) {
    const params = Object.assign({}, req.body, { namespace: req.params.namespace });
    const context = req.context as { extIdNamespaceCreated?: boolean };
    systemAPI.call(req.context, params, methodCallback(res, next, () => context.extIdNamespaceCreated === true ? 201 : 200));
  });
  expressApp.delete(Paths.System + '/admin/ext-id-ns/:namespace', setMethodId('system.extIdNamespaces.delete'), function (req: PryvRequest, res: Response, next: NextFunction) {
    systemAPI.call(req.context, { namespace: req.params.namespace, force: req.query.force === 'true' }, methodCallback(res, next, 204));
  });
  // --------------------- external-id admin release ----------------- //
  // Held on another core: 307 to that core's same route (the /reg/:email/username pattern).
  expressApp.post(Paths.System + '/admin/ext-id/release', contentType.json, setMethodId('system.extIdRelease'), function (req: PryvRequest, res: Response, next: NextFunction) {
    systemAPI.call(req.context, req.body, (err: unknown, result: Record<string, unknown> | null) => {
      if (err == null && typeof result?.redirect === 'string') {
        const server = result.redirect.replace(/\/?$/, '/');
        return res.status(307).location(server + 'system/admin/ext-id/release').json({ server });
      }
      methodCallback(res, next, 200)(err, result);
    });
  });
  // --------------------- auto-deletion reset (admin) ----------------- //
  // The account lives on another core: 307 to that core's same route.
  expressApp.post(Paths.System + '/admin/auto-deletion/clear', contentType.json, setMethodId('system.autoDeletion.reset'), function (req: PryvRequest, res: Response, next: NextFunction) {
    systemAPI.call(req.context, Object.assign({}, req.body), (err: unknown, result: Record<string, unknown> | null) => {
      if (err == null && typeof result?.redirect === 'string') {
        const server = result.redirect.replace(/\/?$/, '/');
        return res.status(307).location(server + 'system/admin/auto-deletion/clear').json({ server });
      }
      methodCallback(res, next, 200)(err, result);
    });
  });
  // --------------------- external-id holder (core to core) ----------------- //
  expressApp.post(Paths.System + '/ext-id/holds', contentType.json, setMethodId('system.extIdHolds'), function (req: PryvRequest, res: Response, next: NextFunction) {
    systemAPI.call(req.context, req.body, methodCallback(res, next, 200));
  });
  // --------------------- erasure ledger ----------------- //
  // The durable records of account erasures, platform-wide (any core answers).
  // The lookup is a POST so that the id or name looked up stays out of URLs
  // and access logs.
  expressApp.get(Paths.System + '/admin/erasures', setMethodId('system.erasures.list'), function (req: PryvRequest, res: Response, next: NextFunction) {
    const params: Record<string, unknown> = {};
    for (const key of ['since', 'limit', 'after']) {
      if (req.query[key] != null) params[key] = req.query[key];
    }
    systemAPI.call(req.context, params, methodCallback(res, next, 200));
  });
  expressApp.post(Paths.System + '/admin/erasures/lookup', contentType.json, setMethodId('system.erasures.get'), function (req: PryvRequest, res: Response, next: NextFunction) {
    systemAPI.call(req.context, Object.assign({}, req.body), methodCallback(res, next, 200));
  });
  // --------------------- effective configuration ----------------- //
  // The configuration this core runs with, secrets redacted; `?digest=true`
  // answers the digests only. Never cached by a client or proxy.
  expressApp.get(Paths.System + '/admin/config/effective', setMethodId('system.getEffectiveConfig'), function (req: PryvRequest, res: Response, next: NextFunction) {
    res.set('Cache-Control', 'no-store');
    systemAPI.call(req.context, Object.assign({}, req.query), methodCallback(res, next, 200));
  });
  // --------------------- event-types dictionary status ----------------- //
  // Reports whether the published event-types dictionary loaded, so operators
  // can alert on a core that is running degraded on its embedded fallback.
  expressApp.get(Paths.System + '/event-types-status', setMethodId('system.getEventTypesStatus'), function (req: PryvRequest, res: Response, next: NextFunction) {
    systemAPI.call(req.context, {}, methodCallback(res, next, 200));
  });
  // --------------------- storage migrations status ----------------- //
  // Whether the storage schema is behind the code (pending migrations), so a
  // deploy script can wait for `bin/migrate.js up` before switching traffic.
  expressApp.get(Paths.System + '/migrations-status', setMethodId('system.getMigrationsStatus'), function (req: PryvRequest, res: Response, next: NextFunction) {
    systemAPI.call(req.context, {}, methodCallback(res, next, 200));
  });
  // --------------------- audit status ----------------- //
  // How many audit records this core could not write since it started, so a
  // monitor can alert on lost records without reading logs.
  expressApp.get(Paths.System + '/audit-status', setMethodId('system.getAuditStatus'), function (req: PryvRequest, res: Response, next: NextFunction) {
    res.set('Cache-Control', 'no-store');
    systemAPI.call(req.context, {}, methodCallback(res, next, 200));
  });
  // --------------------- admin force-renew --------------------- //
  // POST /system/admin/certs/force-renew — operator-triggered ACME
  // rollover. The orchestrator lives in the master process; this worker
  // delegates via cluster IPC and waits for the master's reply.
  // Use cases: key compromise, manual rotation, debugging. Body:
  //   { hostname?: string }   // omit to renew the core's primary host
  // Returns: { ok, hostname, issuedAt, expiresAt }.
  expressApp.post(Paths.System + '/admin/certs/force-renew', contentType.json, setMethodId('system.certs.renew'), adminRoute(), async (req: PryvRequest, res: Response, next: NextFunction) => {
    try {
      const { forceRenew } = require('./forceRenewIpc.ts');
      const hostname = req.body?.hostname;
      setAdminAct(res, { target: { hostname: shortText(hostname) } });
      if (hostname != null && typeof hostname !== 'string') {
        return res.status(400).json({ error: 'hostname must be a string when provided' });
      }
      const reply = await forceRenew({ hostname });
      if (!reply.ok) {
        // 400 covers "not the renewer core", "letsEncrypt not enabled" and
        // ACME failures. The reply.error string is operator-grade and safe
        // to surface (no secret material).
        return res.status(400).json({ ok: false, error: reply.error });
      }
      return res.status(200).json({
        ok: true,
        hostname: reply.hostname,
        issuedAt: reply.issuedAt,
        expiresAt: reply.expiresAt
      });
    } catch (err) {
      logger.error('admin/certs/force-renew failed: ' + errMessage(err));
      next(err);
    }
  });
  // --------------------- admin certs listing ----------------- //
  // Read-only. Returns the cert metadata PlatformDB has (hostname +
  // validity dates) — never the cert or key material itself.
  expressApp.get(Paths.System + '/admin/certs', setMethodId('system.certs.list'), async (req: PryvRequest, res: Response, next: NextFunction) => {
    try {
      const platformDB = require('storages').platformDB;
      const certs: Array<{ hostname?: string; issuedAt?: number; expiresAt?: number }> =
        typeof platformDB.listCertificates === 'function'
          ? await platformDB.listCertificates()
          : [];
      res.status(200).json({
        certs: certs.map((c) => ({
          hostname: c.hostname,
          issuedAt: c.issuedAt,
          expiresAt: c.expiresAt,
          daysUntilExpiry: c.expiresAt != null
            ? Math.round((c.expiresAt - Date.now()) / (24 * 3600 * 1000))
            : null
        }))
      });
    } catch (err) {
      logger.error('admin/certs handler failed: ' + errMessage(err));
      next(err);
    }
  });
  // --------------------- admin mail templates ----------------- //
  // Edit path for in-process mail templates stored in PlatformDB.
  // Reads use application/json; PUT accepts text/plain (raw Pug) OR
  // JSON `{ pug }`. After a write the serving worker refreshes its own
  // materialised Pug tmp-dir before answering, then pushes
  // `mail:template-invalidate` over IPC, which the master relays to the
  // other workers of this core; the workers of other cores read the
  // replicated row at their next start (there is no periodic refresh). When
  // the serving worker cannot reload, the request answers 503 (the row is
  // stored; repeating the request retries the reload). A template outside
  // the allowed Pug subset (see mail/src/templateValidator.ts) is refused.
  async function refreshMailTemplates (): Promise<Error | null> {
    let failure: Error | null = null;
    try {
      await require('mail').refresh();
    } catch (err) {
      logger.warn('mail template refresh failed: ' + errMessage(err));
      failure = errors.apiUnavailable('mail template stored, but this worker could not reload the templates: repeat the request');
    }
    if (typeof process.send === 'function') {
      try { process.send({ type: 'mail:template-invalidate' }); } catch (e) { /* master not attached */ }
    }
    return failure;
  }
  expressApp.get(Paths.System + '/admin/mail/templates', setMethodId('system.mailTemplates.list'), async (req: PryvRequest, res: Response, next: NextFunction) => {
    try {
      const platformDB = require('storages').platformDB;
      const rows: Array<{ type: string; lang: string; part: string; pug: string }> =
        typeof platformDB.getAllMailTemplates === 'function'
          ? await platformDB.getAllMailTemplates()
          : [];
      res.status(200).json({
        templates: rows.map((r) => ({ type: r.type, lang: r.lang, part: r.part, length: r.pug.length }))
      });
    } catch (err) {
      logger.error('admin/mail/templates list failed: ' + errMessage(err));
      next(err);
    }
  });
  expressApp.get(Paths.System + '/admin/mail/templates/:type/:lang/:part', setMethodId('system.mailTemplates.get'), async (req: PryvRequest, res: Response, next: NextFunction) => {
    try {
      const { type, lang, part } = req.params;
      const platformDB = require('storages').platformDB;
      const pug = await platformDB.getMailTemplate(type, lang, part);
      if (pug == null) {
        return next(errors.unknownResource('mail template', `${type}/${lang}/${part}`));
      }
      res.status(200).type('text/plain').send(pug);
    } catch (err) {
      logger.error('admin/mail/templates get failed: ' + errMessage(err));
      next(err);
    }
  });
  expressApp.put(Paths.System + '/admin/mail/templates/:type/:lang/:part', contentType.json, setMethodId('system.mailTemplates.set'), adminRoute(), async (req: PryvRequest, res: Response, next: NextFunction) => {
    try {
      const { type, lang, part } = req.params;
      setAdminAct(res, { target: { type: shortText(type), lang: shortText(lang), part: shortText(part) } });
      const pug = req.body && typeof req.body.pug === 'string' ? req.body.pug : null;
      if (pug == null) return next(errors.invalidRequestStructure('body must be { pug: string }'));
      // The template is recorded by size and digest, never as text.
      setAdminAct(res, { diff: { pug: digestOf(pug) } });
      // Templates compile to code: only the allowed subset is stored.
      const { ok, problems } = validateMailTemplate({ type, lang, part, pug });
      if (!ok) return next(errors.invalidParametersFormat('mail template is not allowed', { problems }));
      const platformDB = require('storages').platformDB;
      await platformDB.setMailTemplate(type, lang, part, pug);
      const reloadFailure = await refreshMailTemplates();
      if (reloadFailure != null) return next(reloadFailure);
      res.status(204).end();
    } catch (err) {
      logger.error('admin/mail/templates put failed: ' + errMessage(err));
      next(err);
    }
  });
  expressApp.delete(Paths.System + '/admin/mail/templates/:type/:lang/:part', setMethodId('system.mailTemplates.delete'), adminRoute(), async (req: PryvRequest, res: Response, next: NextFunction) => {
    try {
      const { type, lang, part } = req.params;
      setAdminAct(res, { target: { type: shortText(type), lang: shortText(lang), part: shortText(part) } });
      const platformDB = require('storages').platformDB;
      await platformDB.deleteMailTemplate(type, lang, part);
      const reloadFailure = await refreshMailTemplates();
      if (reloadFailure != null) return next(reloadFailure);
      res.status(204).end();
    } catch (err) {
      logger.error('admin/mail/templates delete failed: ' + errMessage(err));
      next(err);
    }
  });
  expressApp.post(Paths.System + '/admin/mail/send-test', contentType.json, setMethodId('system.mail.sendTest'), adminRoute(), async (req: PryvRequest, res: Response, next: NextFunction) => {
    try {
      const { type, lang, recipient } = req.body || {};
      // The recipient is not recorded (an address).
      setAdminAct(res, { target: { type: shortText(type), lang: shortText(lang) } });
      if (!type || !lang || !recipient) {
        return next(errors.invalidRequestStructure('body must be { type, lang, recipient }'));
      }
      const recipientObj = typeof recipient === 'string'
        ? { name: recipient, email: recipient }
        : recipient;
      if (!recipientObj.email) {
        return next(errors.invalidRequestStructure('recipient.email is required'));
      }
      const mail = require('mail');
      if (!mail.isActive()) {
        const emailCfg = (config.get('services:email') || {}) as { smtp?: { host?: string }; from?: unknown; defaultLang?: string };
        // Mail not configured is a state of the core, not an unexpected error.
        // send-test always delivers in-process, whatever `method` says; the
        // host check is the shared one (missing or a placeholder).
        if (isInProcessSmtpMissing({ ...emailCfg, method: 'in-process' })) {
          return next(errors.apiUnavailable('Mail is not configured: services.email.smtp.host is required for send-test'));
        }
        const platformDB = require('storages').platformDB;
        await mail.init({
          getAllMailTemplates: platformDB.getAllMailTemplates.bind(platformDB),
          smtp: emailCfg.smtp,
          from: emailCfg.from,
          defaultLang: emailCfg.defaultLang || 'en'
        });
      }
      const result = await mail.send({ type, lang, recipient: recipientObj, substitutions: { username: recipientObj.name || 'send-test', email: recipientObj.email } });
      res.status(200).json({ sent: result.sent === true });
    } catch (err) {
      if (err != null && (err as { id?: string }).id === 'unknown-resource') {
        return next(errors.unknownResource('mail template'));
      }
      logger.error('admin/mail/send-test failed: ' + errMessage(err));
      next(err);
    }
  });
  // --------------------- bootstrap ack ----------------- //
  // POST /system/admin/cores/ack — called by a freshly bootstrapped core.
  // Auth is the one-time join token in the request body, NOT the admin key
  // (the gate lets it through, see system-permissions.ts). The handler verifies the token via
  // TokenStore, flips PlatformDB's `available:true`, returns a cluster snapshot.
  // Refusals share one 401 body; their reason is logged here.
  // Anyone can call it (the token is checked here): a refusal is logged, not stored.
  expressApp.post(Paths.System + '/admin/cores/ack', contentType.json, setMethodId('system.cores.ack'), adminRoute({ recordRefusals: false }), async (req: PryvRequest, res: Response, next: NextFunction) => {
    try {
      // Recorded without a subject (the join token is the credential, never recorded).
      setAdminAct(res, { target: { coreId: shortText(req.body?.coreId) } });
      const TokenStore = require('business/src/bootstrap/index.ts').TokenStore;
      const ackHandler = require('business/src/bootstrap/index.ts').ackHandler;
      const tokensPath = config.get('cluster:tokens:path');
      if (!tokensPath) {
        throw new Error('cluster.tokens.path is not configured');
      }
      const tokenStore = new TokenStore({ path: tokensPath });
      const platformDB = require('storages').platformDB;
      const handle = ackHandler.makeHandler({ tokenStore, platformDB, log: (msg: string) => logger.warn(msg) });
      const result = await handle({ body: req.body, ip: req.ip });
      res.status(result.statusCode).json(result.body);
    } catch (err) {
      logger.error('cores/ack handler failed: ' + errMessage(err));
      next(err);
    }
  });
  // --------------------- user validation (pre-registration) ----------------- //
  expressApp.post(Paths.System + '/users/validate', contentType.json, setMethodId('system.users.validate'), adminRoute(), async (req: PryvRequest, res: Response, next: NextFunction) => {
    try {
      const { username, invitationToken, uniqueFields = {} } = req.body;
      // The names of the unique fields, never their values; no invitation token.
      setAdminAct(res, {
        target: { username: shortText(username), core: shortText(req.body?.core) },
        diff: uniqueFields != null && typeof uniqueFields === 'object' ? { uniqueFields: Object.keys(uniqueFields).filter((k) => k !== 'username').slice(0, 50) } : undefined
      });
      // The username keys the reservation and the invitation claim below.
      if (typeof username !== 'string' || username === '') {
        return res.status(400).json({ reservation: false, error: { id: 'invalid-parameters-format', message: 'username is required' } });
      }
      // Same shape as account creation, checked before anything is reserved:
      // a name creation refuses would otherwise keep its platform rows held.
      if (!USERNAME_RE.test(username)) {
        return res.status(400).json({ reservation: false, error: { id: 'invalid-parameters-format', message: `username: ${USERNAME_MIN_LENGTH} to ${USERNAME_MAX_LENGTH} lowercase letters, digits or dashes, starting and ending with a letter or digit` } });
      }
      const { getPlatform } = require('platform');
      const platform = await getPlatform();

      // An administrator session reserves names for this core only (its grant
      // may cover this core alone); the admin key may name any core.
      if (isAdminSession(req) && req.body.core != null && req.body.core !== platform.coreId) {
        return res.status(400).json({ reservation: false, error: { id: 'invalid-parameters-format', message: 'an administrator session reserves a username for this core only: leave `core` out or name this core' } });
      }

      // 1. Check invitation token via Platform (PlatformDB + config fallback)
      const isTokenValid = await platform.isInvitationTokenValid(invitationToken);
      if (!isTokenValid) {
        return res.status(400).json({ reservation: false, error: { id: 'invitationToken-invalid' } });
      }

      // A provided core must name a registered core, checked before anything
      // is reserved.
      const wantedCore = req.body.core;
      if (wantedCore && !platform.isSingleCore) {
        const problem = coreIdProblem(wantedCore) ??
          ((await platform.getCoreInfo(wantedCore)) == null ? 'unknown core ' + JSON.stringify(wantedCore) : null);
        if (problem != null) {
          return res.status(400).json({ reservation: false, error: { id: 'invalid-parameters-format', message: problem } });
        }
      }

      // Reserved names are refused as on the public registration path
      // (hosted-site names re-read first: another core may advertise a new one).
      await platform.refreshPlatformNames();
      if (platform.isUsernameReserved(username)) {
        return res.status(400).json({ reservation: false, error: { id: 'item-already-exists', data: { username } } });
      }

      // 2. Check username uniqueness PLATFORM-WIDE. The local index holds only
      //    this core's usernames; on multi-core a name reserved here must also
      //    be free on every other core, so consult the shared `user-core/` map
      //    too (single-core reduces to the local check by construction).
      const { getUsersRepository } = require('business/src/users/index.ts');
      const usersRepository = await getUsersRepository();
      if (await usersRepository.usernameExistsOnPlatform(username)) {
        return res.status(400).json({ reservation: false, error: { id: 'item-already-exists', data: { username } } });
      }

      // 3. Check unique fields (mode-aware via Platform).
      delete uniqueFields.username;
      const conflicts: Record<string, unknown> = {};
      for (const [field, value] of Object.entries(uniqueFields)) {
        if (await platform.isUniqueValueTaken(field, value as string)) {
          conflicts[field] = value;
        }
      }
      if (Object.keys(conflicts).length > 0) {
        return res.status(400).json({ reservation: false, error: { id: 'item-already-exists', data: conflicts } });
      }

      // Consume the invitation token atomically, as the public registration
      // does: of concurrent pre-registrations presenting the same token, only
      // one goes on. Claimed only once every check passed, and given back if
      // the reservation below fails, so a refused request never burns it.
      const claim = await platform.claimInvitationToken(invitationToken, username);
      if (claim === 'invalid') {
        return res.status(400).json({ reservation: false, error: { id: 'invitationToken-invalid' } });
      }
      const releaseClaim = async () => {
        if (claim === 'claimed') await platform.releaseInvitationToken(invitationToken, username);
      };

      // The unique-field rows this request wrote, released (owner-guarded)
      // when a later reservation is refused or fails, as the public
      // registration does: otherwise they would block those values for
      // everyone until cleaned up by hand.
      const reservedHere: Array<[string, string]> = [];
      const releaseReserved = async () => {
        for (const [field, value] of reservedHere) {
          await platform.releaseUserUniqueValue(username, field, value);
        }
      };

      try {
        // 4. Reserve unique fields via Platform (hashing applied internally).
        uniqueFields.username = username;
        for (const [field, value] of Object.entries(uniqueFields)) {
          // A row this username already held (an earlier pre-registration of
          // the same name) is not this request's to release.
          const heldBefore = (await platform.getUsersUniqueField(field, value)) === platform.hashFor('username', username);
          const reserved = await platform.setUserUniqueFieldIfNotExists(username, field, value as string);
          if (!reserved) {
            await releaseReserved();
            await releaseClaim();
            return res.status(400).json({ reservation: false, error: { id: 'item-already-exists', data: { [field]: value } } });
          }
          if (!heldBefore) reservedHere.push([field, value as string]);
        }

        // 5. Claim the user-to-core mapping if provided (plaintext input,
        //    hashed internally): never overwrite the mapping of a name another
        //    core already hosts.
        if (req.body.core && !platform.isSingleCore) {
          if (!await platform.setUserCoreIfNotExists(username, req.body.core)) {
            await releaseReserved();
            await releaseClaim();
            return res.status(400).json({ reservation: false, error: { id: 'item-already-exists', data: { username } } });
          }
        }
      } catch (err) {
        try {
          await releaseReserved();
        } catch (releaseErr) {
          logger.error('users/validate: releasing the reserved unique fields failed: ' + errMessage(releaseErr));
        }
        await releaseClaim();
        throw err;
      }

      res.status(200).json({ reservation: true });
    } catch (err) {
      next(err);
    }
  });
  // --------------------- user update (system) ----------------- //
  expressApp.put(Paths.System + '/users', contentType.json, setMethodId('system.users.update'), adminRoute(), async (req: PryvRequest, res: Response, next: NextFunction) => {
    try {
      const { username, user: fieldsForUpdate = {}, fieldsToDelete = {} } = req.body;
      // The names of the fields changed, never their values.
      const names = (o: unknown) => (o != null && typeof o === 'object' ? Object.keys(o).slice(0, 50) : []);
      setAdminAct(res, { target: { username: shortText(username) }, diff: { updated: names(fieldsForUpdate), deleted: names(fieldsToDelete) } });
      if (!username) {
        return next(errors.invalidParametersFormat('Missing username'));
      }
      // An administrator session changes the platform rows of this core's
      // accounts only (its grant may cover this core alone); the admin key
      // keeps the platform-wide write.
      if (isAdminSession(req)) {
        const { getUsersRepository } = require('business/src/users/index.ts');
        if (typeof username !== 'string' || !await (await getUsersRepository()).usernameExists(username)) {
          return next(errors.unknownResource('user', typeof username === 'string' ? username : undefined));
        }
      }
      const { getPlatform } = require('platform');
      const platform = await getPlatform();

      // Prevent username change
      delete fieldsForUpdate.username;
      delete fieldsToDelete.username;

      // Update indexed/unique fields via Platform (mode-aware).
      const systemStreams = require('business/src/system-streams/index.ts');
      const usernameToken = platform.hashFor('username', username);
      // A unique value is claimed, never taken over: a value another account
      // holds is refused (409) before anything is written.
      for (const [field, value] of Object.entries(fieldsForUpdate)) {
        if (!systemStreams.uniqueFieldNames.includes(field)) continue;
        const owner = await platform.getUsersUniqueField(field, value as string);
        if (owner != null && owner !== usernameToken) {
          return next(errors.itemAlreadyExists('user', { [field]: value }));
        }
      }
      for (const [field, value] of Object.entries(fieldsForUpdate)) {
        if (systemStreams.uniqueFieldNames.includes(field)) {
          if (!await platform.setUserUniqueFieldIfNotExists(username, field, value as string)) {
            return next(errors.itemAlreadyExists('user', { [field]: value }));
          }
        }
        if (systemStreams.indexedFieldNames.includes(field)) {
          await platform.setUserIndexedField(username, field, value as string);
        }
      }

      // Delete fields. For unique fields the "did this user own that
      // value?" check compares the row's value (storage form — HMAC in
      // hashed mode) against the hashed username token, so the check
      // works consistently in both modes.
      for (const field of Object.keys(fieldsToDelete)) {
        if (systemStreams.uniqueFieldNames.includes(field)) {
          const currentValue = await platform.getUsersUniqueField(field, fieldsToDelete[field]);
          if (currentValue === usernameToken) {
            await platform.deleteUserUniqueField(field, fieldsToDelete[field]);
          }
        }
        if (systemStreams.indexedFieldNames.includes(field)) {
          await platform.deleteUserIndexedField(username, field);
        }
      }

      await noteTargetAccount(res, username, 'account.platformFields.changedByAdmin');
      res.status(200).json({ user: true });
    } catch (err) {
      next(err);
    }
  });
  // --------------------- user delete (system, with onlyReg/dryRun) ----------------- //
  expressApp.delete(Paths.System + '/users/:username', setMethodId('system.users.delete'), adminRoute(), async (req: PryvRequest, res: Response, next: NextFunction) => {
    try {
      const username = req.params.username;
      const onlyReg = req.query.onlyReg === 'true';
      const dryRun = req.query.dryRun === 'true';
      setAdminAct(res, { target: { username: shortText(username) }, diff: { onlyReg, dryRun } });

      if (!onlyReg) {
        return next(errors.invalidOperation(
          'DELETE /system/users/:username only deletes the user\'s platform-side ' +
          'fields (uniqueFields like email + indexedFields). It does NOT delete ' +
          'the user\'s base storage (events, streams, attachments, audit log). ' +
          'Pass ?onlyReg=true to acknowledge this partial-delete semantic, or ' +
          '?onlyReg=true&dryRun=true to preview without writing. For a FULL ' +
          'cascading delete (base storage + attachments + HF + audit + sessions ' +
          '+ platform fields + index), use DELETE /users/:username on the ' +
          'user\'s core with the admin key in the Authorization header — ' +
          'enabled when `user-account.delete` includes \'adminToken\' (the default).'
        ));
      }

      const { getPlatform } = require('platform');
      const platform = await getPlatform();

      // Check user exists via usersRepository (username is in the user index, not PlatformDB)
      const { getUsersRepository } = require('business/src/users/index.ts');
      const usersRepository = await getUsersRepository();
      if (!await usersRepository.usernameExists(username)) {
        return next(errors.unknownResource());
      }

      if (!dryRun) {
        // Delete this user's platform-side fields (unique + indexed) via the
        // mode-aware Platform layer. It matches rows by the (hashed) username
        // token, so it is correct in both cleartext and hashed piiMode and
        // deletes unique fields as the unique rows they actually are. The
        // previous raw path read a unique field's value from an INDEXED row
        // (which is never written), so it missed the unique row entirely, and
        // it bypassed the hashing layer so it broke outright in hashed mode.
        await platform.deleteUser(username, null);
        // NB: no relationship teardown either (delegations, consent grants):
        // the account stays hosted and usable, so they stay valid. Erasing an
        // account is DELETE /users/:username (auth.delete).
        // NB: the `user-core/` routing row is intentionally NOT removed here.
        // This route is registry-only (onlyReg): it leaves the user's local
        // index entry AND base storage on this core, so the user is still
        // hosted here and MUST stay routable. Deleting the routing row would
        // not free the name (the local index still resolves it) but would make
        // this core's live user unreachable and let another core claim the
        // name. The full cascading delete (DELETE /users/:username) is what
        // frees routing, via repository.deleteOne -> platform.deleteUserCore.
        await noteTargetAccount(res, username, 'account.platformFields.changedByAdmin');
      }

      res.status(200).json({ result: { dryRun: !!dryRun, deleted: !dryRun } });
    } catch (err) {
      next(err);
    }
  });
  // --------------------- account delegation (cross-core invite) ----------------- //
  // B's core delivers (or cancels) a delegation invite to A's core. Admin-key
  // gated by the /system/* guard above. Writes the A-side mirror through the
  // plugin's data-access layer (never the guarded routes). Idempotent per relId.
  expressApp.post(Paths.System + '/delegation/invite', contentType.json, setMethodId('system.delegation.invite'), adminRoute(), async (req: PryvRequest, res: Response, next: NextFunction) => {
    try {
      // The relationship and the local account it is for; no capability.
      setAdminAct(res, { target: { username: shortText(req.body?.delegateUsername), relId: shortText(req.body?.relId) }, diff: { action: shortText(req.body?.action) ?? 'create' } });
      if (config.get('delegation:active') === false) {
        return next(errors.unknownResource());
      }
      const { buildMallForCmc } = require('../methods/helpers/cmcMall.ts');
      const { getUsersRepository } = require('business/src/users/index.ts');
      const delegation = require('delegation');
      const mall = await buildMallForCmc();
      const usersRepository = await getUsersRepository();
      const payload = Object.assign({ action: 'create' }, req.body);
      const result = await delegation.handleSystemInvite({
        mall,
        now: () => Math.floor(Date.now() / 1000),
        resolveLocalUserId: async (username: string) => {
          try { return (await usersRepository.getUserIdForUsername(username)) ?? null; } catch (_e) { return null; }
        }
      }, payload);
      res.status(200).json(result);
    } catch (err) {
      if (err != null && typeof (err as { id?: string }).id === 'string' && (err as { httpStatus?: number }).httpStatus != null) {
        const e = err as { id: string; message: string; httpStatus: number };
        return res.status(e.httpStatus).json({ error: { id: e.id, message: e.message } });
      }
      logger.error('delegation/invite handler failed: ' + errMessage(err));
      next(err);
    }
  });
  // --------------------- account delegation (cross-core create) ----------------- //
  // A's core → the target core: create a brand-new controlled account, active at
  // birth (optional email, optional password → random hash). Admin-key gated by
  // the /system/* guard above. Claims the username platform-wide + creates the
  // user through the repository path, then writes the active anchor + mints the
  // control access; any failure after the claim rolls the whole account back.
  expressApp.post(Paths.System + '/delegation/create-account', contentType.json, setMethodId('system.delegation.createAccount'), adminRoute(), async (req: PryvRequest, res: Response, next: NextFunction) => {
    try {
      // The new account's name and the relationship; no address, no password.
      setAdminAct(res, { target: { username: shortText(req.body?.username), relId: shortText(req.body?.relId) } });
      if (config.get('delegation:active') === false) {
        return next(errors.unknownResource());
      }
      const { buildSystemCreateAccountDeps } = require('../methods/helpers/delegationAccounts.ts');
      const delegation = require('delegation');
      const deps = await buildSystemCreateAccountDeps();
      const result = await delegation.handleSystemCreateAccount(deps, req.body);
      res.status(200).json(result);
    } catch (err) {
      if (err != null && typeof (err as { id?: string }).id === 'string' && (err as { httpStatus?: number }).httpStatus != null) {
        const e = err as { id: string; message: string; httpStatus: number };
        return res.status(e.httpStatus).json({ error: { id: e.id, message: e.message } });
      }
      logger.error('delegation/create-account handler failed: ' + errMessage(err));
      next(err);
    }
  });
  // --------------------- health checks ----------------- //
  expressApp.get(Paths.System + '/check-platform-integrity', setMethodId('system.checkPlatformIntegrity'), function (req: PryvRequest, res: Response, next: NextFunction) {
    systemAPI.call(req.context, {}, methodCallback(res, next, 200));
  });
  // Setup, administrator sessions, roles and claim codes.
  require('./system-setup.ts').default(expressApp, app);
  // One file per administration area, each with its list in systemRoutes/.
  require('./system-admin-roles.ts').default(expressApp, app);
  require('./system-admin-audit.ts').default(expressApp, app);
  require('./system-admin-config.ts').default(expressApp, app);
  require('./system-admin-oauth.ts').default(expressApp, app);
}
