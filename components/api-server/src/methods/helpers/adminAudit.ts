/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
import { createHash } from 'node:crypto';
import { createId as cuid } from '@paralleldrive/cuid2';
import timestamp from 'unix-timestamp';
import type { Request, Response, NextFunction } from 'express';
import type { MethodNext as Next, ResultBag } from '../_types.ts';
import type { AdminSubject } from 'middleware/src/adminAuth.ts';
import type { AdminPermission } from 'business/src/admin/permissions.ts';
import { activeGrants, hasActiveGrant, effectivePermissions } from 'business/src/admin/roles.ts';
import { coreContext } from 'business/src/admin/scopes.ts';
import { readLocalPolicy } from 'business/src/admin/localPolicy.ts';
import { scrubAccountNames as scrubNames } from 'business/src/admin/accountNames.ts';
import { factory as errors } from 'errors';
import { ready, getLogger, getConfigSync } from '@pryv/boiler';
import { getUsersRepository } from 'business/src/users/index.ts';
import { SYSTEM_ROUTES } from '../../routes/system-permissions.ts';
import { isAdminKeyInFullScope } from 'middleware/src/isAdminKey.ts';
import { clientIp } from 'middleware/src/clientIp.ts';

/**
 * Audit steps shared by the methods of the administration routes (`/system`).
 *
 * An act is recorded without a user, in the platform trail of the core: its
 * record (`content.record`) is `{ subject, target?, diff?, result? }`, where
 * `subject` = `{ via, userId?, sessionId?, role?, scope?, localGrant? }` (kind
 * of subject, the administrator's id, a short session id, the grant that gave
 * the route's permission on this core, `localGrant: true` when it is one of
 * this core's local grants), never a code, a token or a secret value. Besides the
 * platform trail, an act is recorded in the trail of the account it reads or
 * changes when that account is on this core, and in the acting
 * administrator's own trail when that account is on this core
 * (`auditAdminAct`).
 */

/** What these steps read from and write to a method context. */
export type AdminAuditContext = {
  methodId?: string;
  adminSubject?: AdminSubject;
  adminPersonal?: { userId: string };
  access?: { id?: string } | null;
  auditIntegrityPayload?: unknown;
  auditErrorRecorded?: boolean;
  /** The account id of the recorded target, being looked up (see `setAuditDetails`). */
  auditTargetPending?: Promise<void>;
};

/** What a record names as the object of an act: an account, an access, a namespace, a core... (never a secret). */
export type AdminTarget = Record<string, string | number | boolean | null>;

export type AdminRecord = {
  subject: Record<string, unknown>;
  target?: AdminTarget;
  diff?: Record<string, unknown>;
  result?: Record<string, unknown>;
};

const SESSION_ID_LENGTH = 16;

type ConfigReader = { get: (key: string) => unknown };
/** The grant a record names as the one that gave the route's permission on this core. */
export type GrantStamp = { role: string; scope: string; local?: true };

/** The permission of the route a method id is served by (route table), if any. */
const permissionOfMethod: Map<string, AdminPermission> = new Map();
for (const entry of SYSTEM_ROUTES) {
  if (entry.methodId != null && entry.rule.auth === 'admin' && entry.rule.permission != null && !permissionOfMethod.has(entry.methodId)) {
    permissionOfMethod.set(entry.methodId, entry.rule.permission);
  }
}

/**
 * The grant of an administrator session that gives `permission` on this
 * core: the first active grant of its row that gives it here (its scope
 * covers this core and this core's local policy accepts it), else this
 * core's local grant that gives it (`scope: core:<this core>`, `local: true`).
 * Null for the admin key, a setup session, a route without a permission.
 */
export function grantGiving (subject: AdminSubject, permission: AdminPermission | undefined, config: ConfigReader = getConfigSync()): GrantStamp | null {
  if (subject.kind !== 'session' || subject.role == null || permission == null) return null;
  const now = Date.now();
  const core = coreContext(config);
  const policy = readLocalPolicy(config);
  // Replicated grants, one at a time (no userId: the local grants are not mixed in).
  for (const grant of activeGrants(subject.role, now)) {
    if (effectivePermissions({ ...subject.role, grants: [grant] }, now, { core, policy }).permissions.has(permission)) {
      return { role: grant.role, scope: grant.scope };
    }
  }
  if (subject.userId == null || !hasActiveGrant(subject.role, now)) return null;
  for (const local of policy.localGrants) {
    if (local.userId !== subject.userId) continue;
    // This local grant alone (the replicated grants refused), as the gate computes it.
    const alone = { acceptReplicatedGrants: false, requireLocalScope: policy.requireLocalScope, localGrants: [local] };
    if (effectivePermissions(subject.role, now, { core, policy: alone, userId: subject.userId }).permissions.has(permission)) {
      return { role: local.role, scope: 'core:' + core.coreId, local: true };
    }
  }
  return null;
}

/** Who acted, as recorded: the access id of the record and its `subject`. */
function attribution (kind: 'subject' | 'personal' | 'public', context: AdminAuditContext, methodId: string | undefined): { accessId: string; subject: Record<string, unknown> } {
  const subject = context.adminSubject;
  let accessId = 'public';
  const record: Record<string, unknown> = {};
  if (kind === 'personal' && context.adminPersonal != null) {
    accessId = 'personal-token';
    record.userId = context.adminPersonal.userId;
  }
  if (kind !== 'public' && subject != null) {
    accessId = subject.kind === 'key' ? 'admin' : subject.kind === 'session' ? 'admin-session' : 'setup-session';
    record.via = subject.kind === 'key' ? 'admin-key' : subject.kind;
    if (subject.userId != null) record.userId = subject.userId;
    if (subject.sessionId != null) record.sessionId = subject.sessionId.slice(0, SESSION_ID_LENGTH);
    const grant = grantGiving(subject, methodId == null ? undefined : permissionOfMethod.get(methodId));
    if (grant != null) {
      record.role = grant.role;
      record.scope = grant.scope;
      if (grant.local === true) record.localGrant = true;
    }
  }
  return { accessId, subject: record };
}

/**
 * The method step that sets the audit access id and the record of who acted:
 * `subject` = the subject the /system gate resolved, `personal` = the account
 * of the personal token the route verified (or the subject when there is
 * one), `public` = nobody.
 */
export function auditAs (kind: 'subject' | 'personal' | 'public') {
  return function setAuditSubject (context: AdminAuditContext, _params: unknown, _result: ResultBag, next: Next) {
    const { accessId, subject } = attribution(kind, context, context.methodId);
    context.access = { id: accessId };
    context.auditIntegrityPayload = { subject };
    scrubQuery(context);
    next();
  };
}

/**
 * Adds to the record prepared by `auditAs` (or `adminRoute`) what the act was
 * on, and what it changed. A target naming a username without its account id
 * gets the id once looked up (`auditTargetPending`, awaited by the error
 * middleware before it records a refusal), as `auditTarget` gives it.
 */
export function setAuditDetails (context: AdminAuditContext, details: { target?: AdminTarget; diff?: Record<string, unknown>; result?: Record<string, unknown> }, opts: { lookUpAccount?: boolean } = {}): void {
  const payload = context.auditIntegrityPayload;
  if (payload == null || typeof payload !== 'object' || !('subject' in payload)) return;
  const record = payload as AdminRecord;
  // No username in clear in a record: its keyed hash (and the account id where the caller knows it).
  if (details.target != null) {
    const scrubbed = scrubAccountNames(details.target);
    record.target = scrubbed;
    const name = details.target.username;
    if (opts.lookUpAccount !== false && details.target.userId == null && typeof name === 'string' && name !== '') {
      context.auditTargetPending = withAccountId(details.target).then((t) => {
        if (t?.userId != null && record.target === scrubbed) record.target = scrubAccountNames(t);
      }, () => {});
    }
  }
  if (details.diff != null) record.diff = scrubAccountNames(details.diff);
  if (details.result != null) record.result = details.result;
}

/**
 * The method step that names the object of the act, from the call's
 * parameters. A username becomes the account id (when it is an account of
 * this core) and the name's keyed hash.
 */
export function auditTarget<P> (targetOf: (params: P) => AdminTarget | null) {
  return async function setAuditTarget (context: AdminAuditContext, params: P, _result: ResultBag, next: Next) {
    try {
      const target = targetOf(params ?? ({} as P));
      if (target != null) setAuditDetails(context, { target: await withAccountId(target) }, { lookUpAccount: false });
    } catch (err) {
      getLogger('system-admin').error('administration audit target not resolved', err);
    }
    next();
  };
}

/** The target recorded by `setAuditDetails`, if any. */
function recordedTarget (context: AdminAuditContext): AdminTarget | undefined {
  const payload = context.auditIntegrityPayload as AdminRecord | undefined;
  return payload?.target;
}

/**
 * The method step (last of a chain) that writes the act in the acting
 * administrator's own trail (`admin.act`), when the subject is an
 * administrator session whose account is on this core. Best-effort.
 */
export function inActorTrail () {
  return async function recordInActorTrail (context: AdminAuditContext, _params: unknown, _result: ResultBag, next: Next) {
    const subject = context.adminSubject;
    if (subject?.kind === 'session' && subject.userId != null && context.methodId != null) {
      const target = recordedTarget(context);
      await auditAdminAct(subject.userId, 'admin.act', target == null ? { methodId: context.methodId } : { methodId: context.methodId, target });
    }
    next();
  };
}

/**
 * A record of an administration act served by an Express handler (no API
 * method): the platform trail, with `{ subject, target?, diff?, result? }`.
 * `outcome` = `valid` for an act done, `error` for one refused. Best-effort:
 * a failure is logged, never thrown (the act itself is done).
 */
export async function recordAdminAct (context: AdminAuditContext & Record<string, unknown>, methodId: string, details: { target?: AdminTarget; diff?: Record<string, unknown>; result?: Record<string, unknown> }, outcome: 'valid' | 'error' = 'valid'): Promise<void> {
  try {
    const config = await ready();
    if (config.get('audit:active') !== true) return;
    if (context.access?.id == null || context.auditIntegrityPayload == null) {
      const { accessId, subject } = attribution('subject', context, methodId);
      context.access = { id: accessId };
      context.auditIntegrityPayload = { subject };
    }
    setAuditDetails(context, details, { lookUpAccount: false });
    context.methodId = methodId;
    const auditSingleton = (await import('audit')).default;
    if (outcome === 'valid') {
      await auditSingleton.validApiCall(context, null);
    } else {
      const status = details.result?.status;
      await auditSingleton.errorApiCall(context, { id: typeof details.result?.error === 'string' ? details.result.error : 'refused', message: 'HTTP ' + String(status ?? '') });
    }
  } catch (err) {
    getLogger('system-admin').error(`administration audit record "${methodId}" not written`, err);
  }
}

type AdminRouteRequest = Request & { context?: AdminAuditContext & Record<string, unknown> };
/** What an Express handler of an administration route sets for its record (`res.locals.adminAct`). */
export type AdminActDetails = { target?: AdminTarget; diff?: Record<string, unknown>; result?: Record<string, unknown>; targetUserId?: string; targetAction?: string };

/**
 * The Express step, right after `setMethodId`, of an administration route
 * served by a handler: sets who acted on the request's context, then, once
 * the answer is sent, records the act (`recordAdminAct`) with what the
 * handler put in `res.locals.adminAct`, and the HTTP status as its result.
 * An error the error middleware already recorded is not recorded twice.
 * Reads declared not audited do not use this step (setMethodId only). An
 * answer never sent (the client went away first) records nothing.
 */
export function adminRoute (opts: { recordRefusals?: boolean } = {}) {
  const recordRefusals = opts.recordRefusals !== false;
  return function adminRouteStep (req: AdminRouteRequest, res: Response, next: NextFunction) {
    const context = req.context;
    if (context == null || context.methodId == null) return next();
    const methodId = context.methodId;
    const { accessId, subject } = attribution('subject', context, methodId);
    context.access = { id: accessId };
    context.auditIntegrityPayload = { subject };
    scrubQuery(context);
    // The handler's details also reach an error record (setAuditDetails on it).
    res.locals.adminContext = context;
    res.on('finish', () => {
      if (context.auditErrorRecorded === true) return;
      const ok = res.statusCode < 400;
      // A route anyone can call (a one-time join token): a refusal is a log line, not a stored record.
      if (!ok && !recordRefusals) {
        getLogger('system-admin').info(`${methodId} refused (${res.statusCode})`);
        return;
      }
      (async () => {
        const raw = (res.locals.adminAct ?? {}) as AdminActDetails;
        const target = await withAccountId(raw.target, raw.targetUserId);
        const act = { ...raw, target: scrubAccountNames(target), diff: scrubAccountNames(raw.diff) };
        const result = Object.assign({ status: res.statusCode }, act.result ?? {});
        await recordAdminAct(context, methodId, { target: act.target, diff: act.diff, result }, ok ? 'valid' : 'error');
        if (!ok) return;
        if (act.targetUserId != null && act.targetAction != null) {
          await auditAdminAct(act.targetUserId, act.targetAction, { methodId, subject, ...(act.diff != null ? { diff: act.diff } : {}) });
        }
        if (context.adminSubject?.kind === 'session' && context.adminSubject.userId != null) {
          await auditAdminAct(context.adminSubject.userId, 'admin.act', act.target == null ? { methodId } : { methodId, target: act.target });
        }
      })().catch((err) => getLogger('system-admin').error(`administration audit records of "${methodId}" not written`, err));
    });
    next();
  };
}

/**
 * What a handler behind `adminRoute()` records of its act: kept for the
 * record written once the answer is sent, and set on the prepared record so
 * that an error the error middleware records keeps it too.
 */
export function setRouteAct (res: Response, details: AdminActDetails): void {
  res.locals.adminAct = Object.assign({}, res.locals.adminAct, details);
  const act = res.locals.adminAct as AdminActDetails;
  if (res.locals.adminContext != null && (details.target != null || details.diff != null || details.targetUserId != null)) {
    const target = act.target != null && act.target.userId == null && act.targetUserId != null ? { userId: act.targetUserId, ...act.target } : act.target;
    setAuditDetails(res.locals.adminContext, { target, diff: act.diff });
  }
}

const NO_TRACING = Object.freeze({ startSpan () {}, finishSpan () {}, logForSpan () {} });

/**
 * For an administration route outside `/system` that the admin key alone
 * opens (`/reg/admin/*`, `/reg/records`): the Express step, before
 * `adminRoute()`, that gives a request authorized by the admin key in full
 * scope the context of an administration act (subject `admin-key`); any
 * other request is left alone (its refusal is the route's, not recorded).
 */
export function adminKeyAct (methodId: string, config: ConfigReader) {
  return function adminKeyActStep (req: AdminRouteRequest, _res: Response, next: NextFunction) {
    if (isAdminKeyInFullScope(req.headers.authorization, config)) {
      const subject: AdminSubject = { kind: 'key', permissions: new Set(), denied: [] };
      req.context = { methodId, adminSubject: subject, source: { name: 'http', ip: clientIp(req) }, tracing: NO_TRACING };
    }
    next();
  };
}

// ------------------------------------------------------------ account names

/**
 * A record part with every username replaced by its keyed hash and the key's
 * id (business/src/admin/accountNames.ts). Without a key, the name is left out.
 */
export function scrubAccountNames<T extends Record<string, unknown> | undefined> (part: T): T {
  return scrubNames(part);
}

/** The request's query string without a username in clear (it is recorded as `content.query`). */
function scrubQuery (context: object): void {
  const c = context as { originalQuery?: unknown };
  const q = c.originalQuery;
  if (q != null && typeof q === 'object' && !Array.isArray(q)) c.originalQuery = scrubAccountNames(q as Record<string, unknown>);
}

/** A target naming a username of this core, with the account id added (best-effort: unknown names stay as they are). */
async function withAccountId (target: AdminTarget | undefined, knownId?: string): Promise<AdminTarget | undefined> {
  if (target == null || target.userId != null) return target;
  if (knownId != null) return { userId: knownId, ...target };
  const name = target.username;
  if (typeof name !== 'string' || name === '') return target;
  try {
    const id = await (await getUsersRepository()).getUserIdForUsername(name.toLowerCase());
    return typeof id === 'string' ? { userId: id, ...target } : target;
  } catch {
    return target;
  }
}

/** A text recorded by size and digest, never by content (a mail template body). */
export function digestOf (text: string): { length: number; sha256: string } {
  return { length: text.length, sha256: createHash('sha256').update(text).digest('hex') };
}

/** The id an act is attributed to in the rows it writes. */
export function actorOf (subject: AdminSubject | undefined): string {
  if (subject?.kind === 'session' && subject.userId != null) return subject.userId;
  return subject?.kind === 'setup' ? 'setup' : 'admin-key';
}

/** A row of the administrator's own trail, when the account is on this core. Best-effort. */
export async function auditAdminAct (userId: string | undefined, action: string, record: Record<string, unknown>): Promise<void> {
  if (userId == null) return;
  try {
    const config = await ready();
    if (config.get('audit:active') !== true) return;
    const usersRepository = await getUsersRepository();
    if ((await usersRepository.getUsernameForUserId(userId)) == null) return; // not an account of this core
    const auditSingleton = (await import('audit')).default;
    const C = auditSingleton.CONSTANTS;
    const now = timestamp.now();
    await auditSingleton.eventForUser(userId, {
      id: cuid(),
      createdBy: 'system',
      modifiedBy: 'system',
      streamIds: [C.ACTION_STREAM_ID_PREFIX + action],
      time: now,
      endTime: now,
      created: now,
      modified: now,
      trashed: false,
      type: 'audit-log/admin',
      content: { action, source: { name: 'admin' }, record }
    }, action);
  } catch (err) {
    getLogger('system-admin').error(`administration audit row "${action}" not written`, err);
  }
}

/**
 * A method step from an async function: a returned error (or a thrown API
 * error) ends the call with it, any other thrown value as an unexpected error.
 */
export function wrap<C> (fn: (context: C, params: Record<string, unknown>, result: ResultBag) => Promise<unknown>) {
  return async function adminStep (context: C, params: Record<string, unknown>, result: ResultBag, next: Next) {
    try {
      const err = await fn(context, params ?? {}, result);
      next(err as Error | undefined);
    } catch (err) {
      next(err instanceof Error && 'id' in err ? err : errors.unexpectedError(err));
    }
  };
}
