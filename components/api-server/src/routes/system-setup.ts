/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
import * as nodeFs from 'node:fs';
import * as nodePath from 'node:path';
import { fileURLToPath } from 'node:url';
import * as storages from 'storages';
import type { AdminStore } from 'business/src/admin/store.ts';
import type { PryvRequest } from './_types.ts';
import type { Application, Response, NextFunction } from 'express';
import { readSetupState } from 'business/src/admin/setupState.ts';
import type { AdminSubject } from 'middleware/src/adminAuth.ts';
import type { AdminPersonal } from '../methods/systemAdmin.ts';
import { factory as errors } from 'errors';
import * as Paths from './Paths.ts';
import methodCallback from './methodCallback.ts';
import { contentType, setMethodId } from 'middleware';
import { MethodContext } from 'business';
import { getUsersRepository } from 'business/src/users/index.ts';
import { platform } from 'platform';

/**
 * Setup, administrator sessions, roles and claim codes. The /system gate
 * (system-permissions.ts) authenticated the caller first.
 *
 *   GET    /system/setup/                    public, the built-in setup page (pending only)
 *   GET    /system/setup/status              public
 *   GET    /system/setup/checks              setup session, admin key (setup:read)
 *   POST   /system/setup/session { code }    public, 10 tries per 15 min per core
 *   POST   /system/setup/first-admin         setup session + { username, personalToken }
 *   POST   /system/setup/finish              setup session or admin key
 *   POST   /system/admin/setup/code          admin key, setup session (setup:write)
 *   POST   /system/admin/session { username } personal token (Authorization), home core
 *   GET    /system/admin/session             admin session
 *   DELETE /system/admin/session             admin session
 *   POST   /system/admin/session/renew       admin session + { personalToken }, home core
 *   POST   /system/admin/session/step-up     admin session + { personalToken }, home core
 *   POST   /system/admin/claim-codes         admin key, claimCodes:mint (step-up)
 *   POST   /system/admin/roles/claim { username, code } personal token, home core
 *   GET    /system/admin/roles               roles:read
 *   DELETE /system/admin/roles/:userId       roles:grant (step-up)
 *   GET    /system/admin/portal/context      any administrator subject
 *   GET    /system/portal/settings           public, the portal's spaces and modules (portal.*)
 *
 * A personal token is valid on its account's home core only: elsewhere these
 * routes answer an error naming the home core's URL.
 */

type AppLike = {
  systemAPI: { call: (...args: unknown[]) => unknown };
  storageLayer?: unknown;
  getCustomAuthFunction?: (from: string) => unknown;
};

type AdminRequest = PryvRequest & { adminSubject?: AdminSubject };

const TOKEN_MAX_LENGTH = 512;

/**
 * Headers of the built-in setup page: its own script and style only, calls
 * to its own origin only, never framed, never cached. `same-origin` keeps
 * the `Origin` header of the page's own calls (a `no-referrer` policy would
 * turn it into `null`).
 */
export const SETUP_PAGE_CSP = "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'";
const SETUP_PAGE_HEADERS = Object.freeze({
  'Content-Security-Policy': SETUP_PAGE_CSP,
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'same-origin',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Resource-Policy': 'same-origin'
});

type SetupPageFile = { name: string; type: string; body: Buffer };

/** The page's files, read once (they ship with the release). */
function loadSetupPage (): { index: SetupPageFile; script: SetupPageFile; style: SetupPageFile } {
  const dir = nodePath.join(nodePath.dirname(fileURLToPath(import.meta.url)), 'setup-page');
  const read = (name: string, type: string): SetupPageFile => ({ name, type, body: nodeFs.readFileSync(nodePath.join(dir, name)) });
  return {
    index: read('index.html', 'text/html; charset=utf-8'),
    script: read('setup.js', 'text/javascript; charset=utf-8'),
    style: read('setup.css', 'text/css; charset=utf-8')
  };
}

function bareToken (raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  const bearer = /^bearer\s+(\S+)$/i.exec(trimmed);
  const token = bearer != null ? bearer[1] : trimmed;
  return token.length > 0 && token.length <= TOKEN_MAX_LENGTH ? token : null;
}

export default function systemSetup (expressApp: Application, app: AppLike) {
  const systemAPI = app.systemAPI;

  function homeCoreError (coreId: string) {
    return errors.invalidOperation('This account\'s home core answers this request: send it there.', { homeCoreUrl: platform.coreIdToUrl(coreId) });
  }

  /** Refuses (with the home core's URL) a request for an account hosted on another core. */
  async function checkHomeCoreOfUsername (username: string): Promise<void> {
    if (platform.isSingleCore) return;
    const coreId = await platform.getUserCore(username);
    if (coreId != null && coreId !== platform.coreId) throw homeCoreError(coreId);
  }

  /** A personal token of an account of this core; any failure is an unknown resource. */
  async function verifyPersonal (req: AdminRequest, username: unknown, rawToken: unknown): Promise<AdminPersonal> {
    const token = bareToken(rawToken);
    if (typeof username !== 'string' || username.length === 0 || username.length > 100 || token == null) throw errors.unknownResource();
    await checkHomeCoreOfUsername(username);
    const source = { name: 'http', ip: (req.context as { source?: { ip?: string } } | undefined)?.source?.ip ?? '' };
    const custom = app.getCustomAuthFunction?.('system-admin') ?? null;
    const ctx = new MethodContext(source, username, token, custom, req.headers, {}, null);
    try {
      await ctx.init();
      await ctx.retrieveExpandedAccess(app.storageLayer, { touchSession: false });
    } catch {
      throw errors.unknownResource();
    }
    if (ctx.access == null || !ctx.access.isPersonal()) throw errors.unknownResource();
    return {
      userId: ctx.user.id,
      username: ctx.user.username,
      token: ctx.accessToken,
      accessId: ctx.access.id,
      lastLogin: typeof ctx.access.lastLogin === 'number' ? ctx.access.lastLogin : null
    };
  }

  function call (req: AdminRequest, res: Response, next: NextFunction, params: Record<string, unknown>, status: number) {
    systemAPI.call(req.context, params, methodCallback(res, next, status));
  }

  /** Runs the method after verifying a personal token (`from`: where the route takes it). */
  function withPersonal (from: (req: AdminRequest) => Promise<{ username: unknown; token: unknown }>) {
    return async function verifyPersonalStep (req: AdminRequest, _res: Response, next: NextFunction) {
      try {
        const { username, token } = await from(req);
        (req.context as { adminPersonal?: AdminPersonal }).adminPersonal = await verifyPersonal(req, username, token);
        next();
      } catch (err) {
        next(err);
      }
    };
  }

  /** The admin session's own account, verified with the personal token of the body, on its home core. */
  const personalOfSession = withPersonal(async (req) => {
    const session = req.adminSubject?.session;
    if (session == null) throw errors.unknownResource();
    if (session.homeCore !== platform.coreId) throw homeCoreError(session.homeCore);
    const username = await (await getUsersRepository()).getUsernameForUserId(session.userId);
    if (username == null) throw errors.unknownResource();
    return { username, token: req.body?.personalToken };
  });

  const body = (req: AdminRequest): Record<string, unknown> => (req.body != null && typeof req.body === 'object' ? req.body : {});

  // --------------------- built-in setup page ----------------- //
  // Static files of this release, served while setup is pending only (404
  // after), on every host and the bare IP like the rest of /system.
  async function servePageFile (req: AdminRequest, res: Response, next: NextFunction, file: SetupPageFile) {
    try {
      const state = await readSetupState(storages.platformDB as AdminStore);
      if (state?.state !== 'pending') return next(errors.unknownResource());
      // `/system/setup` without its slash: the page's relative links need it.
      if (file.name === 'index.html' && !req.path.endsWith('/')) return res.redirect(301, 'setup/');
      res.set(SETUP_PAGE_HEADERS);
      res.type(file.type).status(200).send(file.body);
    } catch (err) {
      next(err);
    }
  }
  const page = loadSetupPage();
  expressApp.get(Paths.System + '/setup/', (req: AdminRequest, res: Response, next: NextFunction) => servePageFile(req, res, next, page.index));
  expressApp.get(Paths.System + '/setup/setup.js', (req: AdminRequest, res: Response, next: NextFunction) => servePageFile(req, res, next, page.script));
  expressApp.get(Paths.System + '/setup/setup.css', (req: AdminRequest, res: Response, next: NextFunction) => servePageFile(req, res, next, page.style));

  // --------------------- setup ----------------- //
  expressApp.get(Paths.System + '/setup/status', setMethodId('system.setup.getStatus'), (req: AdminRequest, res: Response, next: NextFunction) => {
    res.set('Cache-Control', 'no-store');
    call(req, res, next, {}, 200);
  });
  expressApp.get(Paths.System + '/setup/checks', setMethodId('system.setup.getChecks'), (req: AdminRequest, res: Response, next: NextFunction) => {
    res.set('Cache-Control', 'no-store');
    call(req, res, next, {}, 200);
  });
  expressApp.post(Paths.System + '/setup/session', contentType.json, setMethodId('system.setup.createSession'), (req: AdminRequest, res: Response, next: NextFunction) => {
    call(req, res, next, { code: body(req).code }, 201);
  });
  expressApp.post(Paths.System + '/setup/first-admin', contentType.json, setMethodId('system.setup.createFirstAdmin'),
    withPersonal(async (req) => ({ username: body(req).username, token: body(req).personalToken })),
    (req: AdminRequest, res: Response, next: NextFunction) => call(req, res, next, {}, 200));
  expressApp.post(Paths.System + '/setup/finish', setMethodId('system.setup.setReady'), (req: AdminRequest, res: Response, next: NextFunction) => {
    call(req, res, next, {}, 200);
  });
  expressApp.post(Paths.System + '/admin/setup/code', setMethodId('system.setup.replaceCode'), (req: AdminRequest, res: Response, next: NextFunction) => {
    res.set('Cache-Control', 'no-store');
    call(req, res, next, {}, 201);
  });

  // --------------------- administrator sessions ----------------- //
  expressApp.post(Paths.System + '/admin/session', contentType.json, setMethodId('system.adminSession.create'),
    withPersonal(async (req) => ({ username: body(req).username, token: req.headers.authorization })),
    (req: AdminRequest, res: Response, next: NextFunction) => call(req, res, next, {}, 201));
  expressApp.get(Paths.System + '/admin/session', setMethodId('system.adminSession.get'), (req: AdminRequest, res: Response, next: NextFunction) => {
    call(req, res, next, {}, 200);
  });
  expressApp.delete(Paths.System + '/admin/session', setMethodId('system.adminSession.delete'), (req: AdminRequest, res: Response, next: NextFunction) => {
    call(req, res, next, {}, 204);
  });
  expressApp.post(Paths.System + '/admin/session/renew', contentType.json, setMethodId('system.adminSession.updateExpiry'), personalOfSession,
    (req: AdminRequest, res: Response, next: NextFunction) => call(req, res, next, {}, 200));
  expressApp.post(Paths.System + '/admin/session/step-up', contentType.json, setMethodId('system.adminSession.verifyStepUp'), personalOfSession,
    (req: AdminRequest, res: Response, next: NextFunction) => call(req, res, next, {}, 200));

  // --------------------- claim codes and roles ----------------- //
  expressApp.post(Paths.System + '/admin/claim-codes', contentType.json, setMethodId('system.claimCodes.create'), (req: AdminRequest, res: Response, next: NextFunction) => {
    res.set('Cache-Control', 'no-store');
    call(req, res, next, Object.assign({}, body(req)), 201);
  });
  expressApp.post(Paths.System + '/admin/roles/claim', contentType.json, setMethodId('system.roles.claim'),
    withPersonal(async (req) => ({ username: body(req).username, token: req.headers.authorization })),
    (req: AdminRequest, res: Response, next: NextFunction) => call(req, res, next, { code: body(req).code }, 200));
  expressApp.get(Paths.System + '/admin/roles', setMethodId('system.roles.list'), (req: AdminRequest, res: Response, next: NextFunction) => {
    call(req, res, next, {}, 200);
  });
  expressApp.delete(Paths.System + '/admin/roles/:userId', setMethodId('system.roles.delete'), (req: AdminRequest, res: Response, next: NextFunction) => {
    const params: Record<string, unknown> = { userId: req.params.userId };
    if (req.query.role != null) params.role = req.query.role;
    if (req.query.scope != null) params.scope = req.query.scope;
    call(req, res, next, params, 200);
  });

  // --------------------- portal ----------------- //
  expressApp.get(Paths.System + '/admin/portal/context', setMethodId('system.portalContext.get'), (req: AdminRequest, res: Response, next: NextFunction) => {
    res.set('Cache-Control', 'no-store');
    call(req, res, next, {}, 200);
  });
  expressApp.get(Paths.System + '/portal/settings', setMethodId('system.portalSettings.get'), (req: AdminRequest, res: Response, next: NextFunction) => {
    res.set('Cache-Control', 'no-store');
    call(req, res, next, {}, 200);
  });
}
