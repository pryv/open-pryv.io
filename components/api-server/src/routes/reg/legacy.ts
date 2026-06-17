/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
import { createRequire } from 'node:module';
import type { Request, Response, NextFunction, Application as ExpressApp } from 'express';

const require = createRequire(import.meta.url);
/**
 * Legacy service-register routes preserved for backward compatibility.
 * These map onto service-core's PlatformDB and usersRepository.
 */

const errors = require('errors').factory;

type App = { config: { get (key: string): unknown } };
type UserCore = { coreId: string; username: string };
type UsersRepoLike = { usernameExists: (username: string) => Promise<boolean>; count: () => Promise<number> };

export default function (expressApp: ExpressApp, app: App) {
  const adminAccessKey = app.config.get('auth:adminAccessKey') as string;
  const domain = app.config.get('dns:domain') as string;

  // Lazy-loaded dependencies (avoid circular requires at module load)
  let _usersRepository: UsersRepoLike | undefined;
  async function getUsersRepository (): Promise<UsersRepoLike> {
    if (!_usersRepository) {
      const { getUsersRepository: getRepo } = require('business/src/users/index.ts');
      _usersRepository = await getRepo();
    }
    return _usersRepository!;
  }

  function getPlatformDB () {
    return require('storages').platformDB;
  }

  // --- Admin auth middleware (same as system routes) ---
  function checkAdmin (req: Request, _res: Response, next: NextFunction) {
    const secret = req.headers.authorization;
    if (secret == null || secret !== adminAccessKey) {
      return next(errors.unknownResource());
    }
    next();
  }

  // =====================================================================
  // Email → username lookups
  // =====================================================================

  /**
   * Resolve the cleartext username owning `email`, handling hashed mode.
   *
   * In `cleartext` mode PlatformDB hands back the cleartext username
   * directly. In `hashed` mode it hands back the HMAC username token; the
   * cleartext only exists on the user's HOME core (in its local,
   * non-replicated user index). So:
   *  - single-core / home-is-this-core → reverse-resolve the token locally.
   *  - home is another core → return a redirect to it; that core runs the
   *    same resolution against its own local index.
   *
   * Returns one of:
   *  - `{ username }`        — resolved here
   *  - `{ redirect: url }`   — home core is elsewhere (slash-terminated url)
   *  - `{ notFound: true }`  — no user owns this email (or token not
   *                            resolvable locally even though it should be)
   */
  async function resolveUsernameByEmail (email: string):
  Promise<{ username?: string; redirect?: string; notFound?: boolean }> {
    const { getPlatform } = require('platform');
    const platform = await getPlatform();
    // `getUsersUniqueField` hashes `email` internally in hashed mode and
    // returns the row VALUE (cleartext username, or HMAC username token).
    const usernameOrToken = await platform.getUsersUniqueField('email', email);
    if (usernameOrToken == null) return { notFound: true };

    if (!platform.piiModeIsHashed) return { username: usernameOrToken };

    // Hashed mode: usernameOrToken is the HMAC username token.
    if (!platform.isSingleCore) {
      const homeCoreId = await platform.getUserCoreByPreHashedUsername(usernameOrToken);
      if (homeCoreId == null) return { notFound: true };
      if (homeCoreId !== platform.coreId) {
        return { redirect: platform.coreIdToUrl(homeCoreId) };
      }
    }
    const username = await platform.resolveLocalUsernameFromToken(usernameOrToken);
    if (username == null) return { notFound: true };
    return { username };
  }

  /**
   * GET /:email/username — get username from email. Returns { username },
   * a 307 redirect to the user's home core (hashed multi-core), or 404.
   *
   * The 307 carries a `Location` header AND a JSON body (`{ server }`) so
   * non-redirect-following clients can act on it. The home core resolves
   * the HMAC username token back to cleartext from its in-region local
   * index — cleartext usernames never cross Raft.
   */
  expressApp.get('/reg/:email/username', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const email = String(req.params.email);
      const r = await resolveUsernameByEmail(email);
      if (r.notFound) {
        return res.status(404).json({ error: { id: 'unknown-email', message: 'Unknown email' } });
      }
      if (r.redirect != null) {
        const target = r.redirect + 'reg/' + encodeURIComponent(email) + '/username';
        return res.status(307).location(target).json({ server: r.redirect });
      }
      res.json({ username: r.username });
    } catch (err) {
      next(err);
    }
  });

  /**
   * GET /:email/uid — deprecated alias, returns { uid }. Same redirect/
   * resolve behaviour as /:email/username above.
   */
  expressApp.get('/reg/:email/uid', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const email = String(req.params.email);
      const r = await resolveUsernameByEmail(email);
      if (r.notFound) {
        return res.status(404).json({ error: { id: 'unknown-email', message: 'Unknown email' } });
      }
      if (r.redirect != null) {
        const target = r.redirect + 'reg/' + encodeURIComponent(email) + '/uid';
        return res.status(307).location(target).json({ server: r.redirect });
      }
      res.json({ uid: r.username });
    } catch (err) {
      next(err);
    }
  });

  // =====================================================================
  // Server/core discovery (legacy /:uid/server)
  // =====================================================================

  /**
   * GET /:uid/server — redirect to the core hosting this user.
   */
  expressApp.get('/reg/:uid/server', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const username = req.params.uid as string;
      // Prefer PlatformDB (rqlite, replicated) over per-core usersLocalIndex —
      // in multi-core mode, a user's SQLite index only exists on their home
      // core, so any core that is NOT the user's home would 404 even though
      // it can legitimately redirect them.
      const coreUrl = await getCoreUrlForUser(username);
      if (coreUrl == null) {
        return res.status(404).json({
          error: { id: 'unknown-user', message: 'Unknown user' }
        });
      }
      // coreUrl is slash-terminated (Platform.coreIdToUrl convention).
      res.redirect(coreUrl + '?username=' + username);
    } catch (err) {
      next(err);
    }
  });

  /**
   * POST /:uid/server — JSON response with server and alias.
   */
  expressApp.post('/reg/:uid/server', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const username = req.params.uid as string;
      const coreUrl = await getCoreUrlForUser(username);
      if (coreUrl == null) {
        return res.status(404).json({
          error: { id: 'unknown-user', message: 'Unknown user' }
        });
      }
      const alias = domain ? username + '.' + domain : username;
      res.json({ server: coreUrl, alias });
    } catch (err) {
      next(err);
    }
  });

  // =====================================================================
  // Admin: individual user details
  // =====================================================================

  /**
   * GET /admin/users/:username — get user details (system role).
   */
  expressApp.get('/reg/admin/users/:username', checkAdmin, async (req: Request, res: Response, next: NextFunction) => {
    try {
      const username = req.params.username as string;
      const usersRepo = await getUsersRepository();
      if (!await usersRepo.usernameExists(username)) {
        return res.status(404).json({
          error: { id: 'unknown-user', message: 'User not found' }
        });
      }
      const { getPlatform } = require('platform');
      const platform = await getPlatform();
      const systemStreams = require('business/src/system-streams/index.ts');
      const userInfo: Record<string, unknown> = { username };

      // Collect indexed fields via Platform (mode-aware: hashes username
      // key in hashed mode, identity in cleartext). Field VALUES on
      // indexed fields stay cleartext in both modes.
      for (const field of systemStreams.indexedFieldNames) {
        const value = await platform.getUserIndexedField(username, field);
        if (value != null) userInfo[field] = value;
      }

      res.json(userInfo);
    } catch (err) {
      next(err);
    }
  });

  // =====================================================================
  // Admin: servers (cores) management
  // =====================================================================

  /**
   * GET /admin/servers — list cores with user counts.
   * Maps to the multi-core PlatformDB.
   */
  expressApp.get('/reg/admin/servers', checkAdmin, async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { getPlatform } = require('platform');
      const platform = await getPlatform();
      const cores = await platform.getAllCoreInfos();
      const allUserCores = await getPlatformDB().getAllUserCores();

      const servers: Record<string, { userCount: number }> = {};
      for (const core of cores) {
        const coreUrl = platform.coreIdToUrl(core.id);
        const userCount = allUserCores.filter((uc: UserCore) => uc.coreId === core.id).length;
        servers[coreUrl] = { userCount };
      }

      // Single-core fallback: count all users
      if (Object.keys(servers).length === 0) {
        const usersRepo = await getUsersRepository();
        const count = await usersRepo.count();
        const url = platform.coreUrl || app.config.get('dnsLess:publicUrl') || 'localhost';
        servers[url] = { userCount: count };
      }

      res.json({ servers });
    } catch (err) {
      next(err);
    }
  });

  /**
   * GET /admin/servers/:serverName/users — list users on a specific core.
   */
  expressApp.get('/reg/admin/servers/:serverName/users', checkAdmin, async (req: Request, res: Response, next: NextFunction) => {
    try {
      const serverName = req.params.serverName;
      const { getPlatform } = require('platform');
      const platform = await getPlatform();
      const allUserCores = await getPlatformDB().getAllUserCores();

      // Find coreId matching this serverName (could be URL or coreId)
      const cores = await platform.getAllCoreInfos();
      const matchingCore = cores.find((c: { id: string }) =>
        c.id === serverName ||
        platform.coreIdToUrl(c.id).includes(serverName)
      );

      if (!matchingCore) {
        return res.json({ users: [] });
      }

      const users = allUserCores
        .filter((uc: UserCore) => uc.coreId === matchingCore.id)
        .map((uc: UserCore) => ({ username: uc.username }));

      res.json({ users });
    } catch (err) {
      next(err);
    }
  });

  /**
   * GET /admin/servers/:src/rename/:dst — rename server (migrate users).
   * In multi-core: updates user-to-core mappings in PlatformDB.
   */
  expressApp.get('/reg/admin/servers/:srcServerName/rename/:dstServerName', checkAdmin, async (req: Request, res: Response, next: NextFunction) => {
    try {
      const srcName = req.params.srcServerName;
      const dstName = req.params.dstServerName;
      const { getPlatform } = require('platform');
      const platform = await getPlatform();
      // getAllUserCores returns mappings with `username` in PlatformDB
      // storage form (HMAC token in hashed mode). Re-writing must skip
      // the hashing layer to avoid double-hashing — use the
      // *ByPreHashedUsername variant.
      const allUserCores = await platform.getAllUserCores();

      let count = 0;
      for (const uc of allUserCores) {
        if (uc.coreId === srcName) {
          await platform.setUserCoreByPreHashedUsername(uc.username, dstName);
          count++;
        }
      }

      res.json({ count });
    } catch (err) {
      next(err);
    }
  });

  // =====================================================================
  // Admin: invitations
  // =====================================================================

  /**
   * GET /admin/invitations — list all invitation tokens.
   */
  expressApp.get('/reg/admin/invitations', checkAdmin, async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { getPlatform } = require('platform');
      const platform = await getPlatform();
      const invitations = await platform.getAllInvitationTokens();
      res.json({ invitations });
    } catch (err) {
      next(err);
    }
  });

  /**
   * GET /admin/invitations/post — generate new invitation tokens.
   * Query params: count (number), message (optional description).
   */
  expressApp.get('/reg/admin/invitations/post', checkAdmin, async (req: Request, res: Response, next: NextFunction) => {
    try {
      const count = parseInt(String(req.query.count)) || 1;
      const message = (req.query.message as string) || '';
      const { getPlatform } = require('platform');
      const platform = await getPlatform();
      const data = await platform.generateInvitationTokens(count, 'admin', message);
      res.json({ data });
    } catch (err) {
      next(err);
    }
  });

  // =====================================================================
  // Helper
  // =====================================================================

  async function getCoreUrlForUser (username: string) {
    const { getPlatform } = require('platform');
    const platform = await getPlatform();

    if (!platform.isSingleCore) {
      const coreId = await platform.getUserCore(username);
      if (coreId != null) {
        return platform.coreIdToUrl(coreId);
      }
      // Multi-core + no user-core mapping → unknown user.
      return null;
    }
    // Single-core: verify the user actually exists before claiming to host
    // them — otherwise `/reg/:uid/server` would return the local URL for
    // any arbitrary username, shadowing the 404 the route is supposed to
    // produce for unknown users.
    const usersRepo = await getUsersRepository();
    if (!await usersRepo.usernameExists(username)) {
      return null;
    }
    return platform.coreUrl || app.config.get('dnsLess:publicUrl') || 'http://localhost:3000';
  }
};
