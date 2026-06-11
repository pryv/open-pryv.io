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
   * GET /:email/username — get username from email.
   * Returns { username } or 404.
   */
  expressApp.get('/reg/:email/username', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const email = req.params.email;
      const platformDB = getPlatformDB();
      const username = await platformDB.getUsersUniqueField('email', email);
      if (username == null) {
        return res.status(404).json({
          error: { id: 'unknown-email', message: 'Unknown email' }
        });
      }
      res.json({ username });
    } catch (err) {
      next(err);
    }
  });

  /**
   * GET /:email/uid — deprecated alias, returns { uid }.
   */
  expressApp.get('/reg/:email/uid', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const email = req.params.email;
      const platformDB = getPlatformDB();
      const username = await platformDB.getUsersUniqueField('email', email);
      if (username == null) {
        return res.status(404).json({
          error: { id: 'unknown-email', message: 'Unknown email' }
        });
      }
      res.json({ uid: username });
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
      const platformDB = getPlatformDB();
      const systemStreams = require('business/src/system-streams/index.ts');
      const userInfo: Record<string, unknown> = { username };

      // Collect indexed fields from PlatformDB
      for (const field of systemStreams.indexedFieldNames) {
        const value = await platformDB.getUserIndexedField(username, field);
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
      const platformDB = getPlatformDB();
      const allUserCores = await platformDB.getAllUserCores();

      let count = 0;
      for (const uc of allUserCores) {
        if (uc.coreId === srcName) {
          await platformDB.setUserCore(uc.username, dstName);
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
