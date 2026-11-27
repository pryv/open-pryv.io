/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
import type { Request, Response, NextFunction, RequestHandler } from 'express';
import { factory as errors } from 'errors';
import isAdminKey from './isAdminKey.ts';
import { PERMISSIONS, STEP_UP_PERMISSIONS } from 'business/src/admin/permissions.ts';
import type { AdminPermission } from 'business/src/admin/permissions.ts';
import { resolveAdminSession, readSetupSession, isStepUpFresh } from 'business/src/admin/sessions.ts';
import type { AdminSession, SetupSession } from 'business/src/admin/sessions.ts';
import type { RoleRow, DeniedPermission } from 'business/src/admin/roles.ts';
import { coreContext } from 'business/src/admin/scopes.ts';
import { readLocalPolicy } from 'business/src/admin/localPolicy.ts';
import { readSetupState } from 'business/src/admin/setupState.ts';
import { readAdminConfig, portalUrl } from 'business/src/admin/config.ts';
import { hashToken } from 'business/src/admin/codes.ts';
import type { AdminStore } from 'business/src/admin/store.ts';

/**
 * The authentication gate of the `/system/*` routes.
 *
 * A request authenticates with one of:
 * - the admin key (`Authorization: <auth.adminAccessKey>`), subject to
 *   `auth.adminAccessKeyScope` (`break-glass`: only the routes marked so);
 * - an administrator session (`Authorization: AdminSession <token>`), once
 *   setup is finished: its account's role row gives the permissions on this
 *   core (the grants whose scope covers this core, under this core's
 *   `admin.localPolicy`), checked against the route's; a step-up permission
 *   also needs a recent second factor;
 * - a setup session (`Authorization: SetupSession <token>`), while setup is
 *   pending, on the routes that accept one.
 * Some routes check their own credential (a personal token of the account, a
 * one-time join token) or need none: the gate lets them through.
 *
 * Every refusal answers 404, as an unknown route does (no hint to retry).
 * The resolved subject `{ kind, userId?, permissions, denied }` is set on the
 * request (`req.adminSubject`) and its method context. The admin key and the
 * setup session hold every permission: a local policy binds role holders,
 * not them (the key's reach is `auth.adminAccessKeyScope`).
 *
 * Origin rule: a request that carries an `Origin` and is not authenticated by
 * the admin key is accepted only from the core's own origin, the platform's
 * portal origin (`portal.site` with the topology, or `portal.url`) or one listed in
 * `portal.cors.allowedOrigins`, and gets CORS headers for that origin only.
 * Admin-key calls and requests without `Origin` keep the API-wide behaviour.
 */

export type AdminSubjectKind = 'key' | 'session' | 'setup';

export type AdminSubject = {
  kind: AdminSubjectKind;
  /** The administrator's account (admin session). */
  userId?: string;
  permissions: ReadonlySet<AdminPermission>;
  /** Admin session: the permissions of its roles not held on this core, and why (empty for the key and setup). */
  denied: readonly DeniedPermission[];
  /** Admin session: its row, its role row and its id (the token's SHA-256, for audit records). */
  session?: AdminSession;
  role?: RoleRow;
  sessionId?: string;
  setupSession?: SetupSession;
  /** The bearer of a session (to end or renew it). Never logged. */
  token?: string;
};

/**
 * What a route under `/system` accepts.
 * - `admin`: a subject of one of `accepts` (default key and session) holding
 *   `permission` (null: any subject of those kinds); `breakGlass` marks the
 *   routes the admin key still reaches with `auth.adminAccessKeyScope: break-glass`.
 * - `public`: no credential. `personal`: the route checks a personal token of
 *   the account. `joinToken`: the route checks a one-time join token.
 */
export type AdminRouteRule =
  | { auth: 'admin'; permission: AdminPermission | null; breakGlass?: boolean; accepts?: readonly AdminSubjectKind[] }
  | { auth: 'public' }
  | { auth: 'personal' }
  | { auth: 'joinToken' };

type ConfigReader = { get: (key: string) => unknown };

export type AdminAuthOptions = {
  /** The rule of the route a request goes to, or null for a path no route serves. */
  rule: (method: string, path: string) => AdminRouteRule | null;
  config: ConfigReader;
  /** The platform store (read at each request). */
  store: () => AdminStore;
  /** Called on each refusal (no header, no body: a near-miss credential must not land in a log). */
  onRefused?: (req: Request, reason: string) => void;
  now?: () => number;
};

type AdminRequest = Request & { adminSubject?: AdminSubject; context?: { adminSubject?: AdminSubject } };

const ALL_PERMISSIONS: ReadonlySet<AdminPermission> = new Set(PERMISSIONS);
const DEFAULT_ACCEPTS: readonly AdminSubjectKind[] = ['key', 'session'];

type Credential =
  | { kind: 'session'; token: string }
  | { kind: 'setup'; token: string }
  | { kind: 'other'; raw: unknown };

/** The credential an `Authorization` header carries (schemes compare case-insensitively). */
export function parseAdminAuthorization (header: unknown): Credential {
  if (typeof header === 'string') {
    const m = /^(AdminSession|SetupSession)\s+(\S+)\s*$/i.exec(header);
    if (m != null) return { kind: m[1].toLowerCase() === 'adminsession' ? 'session' : 'setup', token: m[2] };
  }
  return { kind: 'other', raw: header };
}

function originOf (url: unknown): string | null {
  if (typeof url !== 'string' || url === '') return null;
  try {
    const origin = new URL(url).origin;
    return origin === 'null' ? null : origin;
  } catch {
    return null;
  }
}

/**
 * The origins of this core itself: the request's own `Host` (under https and
 * http: behind a TLS proxy that is not a trusted proxy the core sees http
 * while the browser sends `Origin: https://...`; a foreign site cannot share
 * the host either way), `core.url` and, in dnsLess, `dnsLess.publicUrl`.
 * What the built-in setup page is served from.
 */
export function ownOrigins (config: ConfigReader, req?: Request): Set<string> {
  const out = new Set<string>();
  const add = (o: string | null) => { if (o != null) out.add(o.toLowerCase()); };
  if (req != null && typeof req.headers.host === 'string') {
    add(originOf(`https://${req.headers.host}`));
    add(originOf(`http://${req.headers.host}`));
  }
  add(originOf(config.get('core:url')));
  if (config.get('dnsLess:isActive') === true) add(originOf(config.get('dnsLess:publicUrl')));
  return out;
}

/** Whether `origin` (an `Origin` header value) is one of this core's own origins. */
export function isOwnOrigin (config: ConfigReader, req: Request, origin: unknown): boolean {
  return typeof origin === 'string' && origin !== '' && ownOrigins(config, req).has(origin.toLowerCase());
}

/** The origins a portal call is accepted from (the request's own origin included). */
export function allowedPortalOrigins (config: ConfigReader, req?: Request): Set<string> {
  const out = ownOrigins(config, req);
  const add = (o: string | null) => { if (o != null) out.add(o.toLowerCase()); };
  try {
    add(originOf(portalUrl(config)));
    for (const o of readAdminConfig(config).portal.allowedOrigins) add(originOf(o));
  } catch {
    // Invalid administration configuration: the core does not boot with it.
  }
  return out;
}

/** Whether the request's `Origin` (if any) may make a portal call. */
export function isPortalOriginAllowed (config: ConfigReader, req: Request): boolean {
  const origin = req.headers.origin;
  if (origin == null) return true;
  if (typeof origin !== 'string') return false;
  return allowedPortalOrigins(config, req).has(origin.toLowerCase());
}

/**
 * For `commonHeaders`' `ownCors`: true for a `/system` request (not a
 * preflight) that carries an `Origin` and is not authenticated by the admin
 * key; the gate then answers CORS for an allowed origin only.
 */
export function isPortalCorsRequest (config: ConfigReader, req: Request): boolean {
  if (req.method === 'OPTIONS' || req.headers.origin == null) return false;
  if (!/^\/system(\/|$)/i.test(req.path)) return false;
  return !isAdminKey(req.headers.authorization, config.get('auth:adminAccessKey'));
}

function setPortalCors (req: Request, res: Response): void {
  const origin = req.headers.origin;
  if (typeof origin !== 'string') return;
  res.header('Access-Control-Allow-Origin', origin);
  res.header('Access-Control-Expose-Headers', 'API-Version, Retry-After');
  res.vary('Origin');
}

function accepts (rule: { accepts?: readonly AdminSubjectKind[] }, kind: AdminSubjectKind): boolean {
  return (rule.accepts ?? DEFAULT_ACCEPTS).includes(kind);
}

export default function adminAuth (opts: AdminAuthOptions): RequestHandler {
  const now = opts.now ?? Date.now;
  const config = opts.config;

  return async function adminAuthGate (req: AdminRequest, res: Response, next: NextFunction) {
    function refuse (reason: string) {
      opts.onRefused?.(req, reason);
      next(errors.unknownResource());
    }
    function admit (subject: AdminSubject) {
      req.adminSubject = subject;
      if (req.context != null) req.context.adminSubject = subject;
      next();
    }
    try {
      const rule = opts.rule(req.method, req.path);
      const credential = parseAdminAuthorization(req.headers.authorization);

      // The admin key: the API-wide behaviour (CORS included), as before sessions.
      if (credential.kind === 'other' && isAdminKey(credential.raw, config.get('auth:adminAccessKey'))) {
        const breakGlass = readAdminConfig(config).adminAccessKeyScope === 'break-glass';
        // A path no route of the table serves: on to the routes (they answer
        // 404), except under break-glass, where the key reaches listed routes only.
        if (rule == null) return breakGlass ? refuse('admin key outside its break-glass scope') : next();
        if (rule.auth !== 'admin') return next();
        if (!accepts(rule, 'key')) return refuse('admin key not accepted on this route');
        if (breakGlass && rule.breakGlass !== true) {
          return refuse('admin key outside its break-glass scope');
        }
        return admit({ kind: 'key', permissions: ALL_PERMISSIONS, denied: [] });
      }

      if (rule == null) return refuse('no such route');
      if (!isPortalOriginAllowed(config, req)) return refuse('origin not allowed');
      if (req.headers.origin != null) setPortalCors(req, res);
      if (rule.auth !== 'admin') return next();

      const store = opts.store();
      if (credential.kind === 'session') {
        if (!accepts(rule, 'session')) return refuse('admin session not accepted on this route');
        // Administrator sessions open once setup is finished.
        if ((await readSetupState(store))?.state === 'pending') return refuse('setup is pending');
        const at = now();
        const resolved = await resolveAdminSession(store, credential.token, at,
          { core: coreContext(config), policy: readLocalPolicy(config) });
        if (resolved == null) return refuse('unknown or ended admin session');
        if (rule.permission != null) {
          if (!resolved.permissions.has(rule.permission)) return refuse('permission not held');
          if (STEP_UP_PERMISSIONS.has(rule.permission) &&
              !isStepUpFresh(resolved.session, at, readAdminConfig(config).session.stepUpMs)) {
            return next(errors.forbidden('This act needs a recent second factor: renew it with POST /system/admin/session/step-up, then repeat the request.', { stepUp: true }));
          }
        }
        return admit({
          kind: 'session',
          userId: resolved.session.userId,
          permissions: resolved.permissions,
          denied: resolved.denied,
          session: resolved.session,
          role: resolved.role,
          sessionId: hashToken(credential.token),
          token: credential.token
        });
      }
      if (credential.kind === 'setup') {
        if (!accepts(rule, 'setup')) return refuse('setup session not accepted on this route');
        if ((await readSetupState(store))?.state !== 'pending') return refuse('setup is not pending');
        const setupSession = await readSetupSession(store, credential.token);
        if (setupSession == null) return refuse('unknown or ended setup session');
        // The setup code is the operator's proof: while pending, its session acts as the admin key does.
        return admit({ kind: 'setup', permissions: ALL_PERMISSIONS, denied: [], setupSession, sessionId: hashToken(credential.token), token: credential.token });
      }
      return refuse('no valid credential');
    } catch (err) {
      next(err);
    }
  } as RequestHandler;
}
