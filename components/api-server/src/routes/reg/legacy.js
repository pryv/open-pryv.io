/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/**
 * Legacy service-register routes preserved for backward compatibility.
 * These map onto service-core's PlatformDB and usersRepository.
 */

const errors = require('errors').factory;

module.exports = function (expressApp, app) {
  const adminAccessKey = app.config.get('auth:adminAccessKey');
  const domain = app.config.get('dns:domain');

  // Lazy-loaded dependencies (avoid circular requires at module load)
  let _usersRepository;
  async function getUsersRepository () {
    if (!_usersRepository) {
      const { getUsersRepository: getRepo } = require('business/src/users');
      _usersRepository = await getRepo();
    }
    return _usersRepository;
  }

  function getPlatformDB () {
    return require('storages').platformDB;
  }

  // --- Admin auth middleware (same as system routes) ---
  function checkAdmin (req, res, next) {
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
  expressApp.get('/reg/:email/username', async (req, res, next) => {
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
  expressApp.get('/reg/:email/uid', async (req, res, next) => {
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
  expressApp.get('/reg/:uid/server', async (req, res, next) => {
    try {
      const username = req.params.uid;
      const usersRepo = await getUsersRepository();
      if (!await usersRepo.usernameExists(username)) {
        return res.status(404).json({
          error: { id: 'unknown-user', message: 'Unknown user' }
        });
      }
      const coreUrl = await getCoreUrlForUser(username);
      res.redirect(coreUrl + '/?username=' + username);
    } catch (err) {
      next(err);
    }
  });

  /**
   * POST /:uid/server — JSON response with server and alias.
   */
  expressApp.post('/reg/:uid/server', async (req, res, next) => {
    try {
      const username = req.params.uid;
      const usersRepo = await getUsersRepository();
      if (!await usersRepo.usernameExists(username)) {
        return res.status(404).json({
          error: { id: 'unknown-user', message: 'Unknown user' }
        });
      }
      const coreUrl = await getCoreUrlForUser(username);
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
  expressApp.get('/reg/admin/users/:username', checkAdmin, async (req, res, next) => {
    try {
      const username = req.params.username;
      const usersRepo = await getUsersRepository();
      if (!await usersRepo.usernameExists(username)) {
        return res.status(404).json({
          error: { id: 'unknown-user', message: 'User not found' }
        });
      }
      const platformDB = getPlatformDB();
      const systemStreams = require('business/src/system-streams');
      const userInfo = { username };

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
  expressApp.get('/reg/admin/servers', checkAdmin, async (req, res, next) => {
    try {
      const { getPlatform } = require('platform');
      const platform = await getPlatform();
      const cores = await platform.getAllCoreInfos();
      const allUserCores = await getPlatformDB().getAllUserCores();

      const servers = {};
      for (const core of cores) {
        const coreUrl = platform.coreIdToUrl(core.id);
        const userCount = allUserCores.filter(uc => uc.coreId === core.id).length;
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
  expressApp.get('/reg/admin/servers/:serverName/users', checkAdmin, async (req, res, next) => {
    try {
      const serverName = req.params.serverName;
      const { getPlatform } = require('platform');
      const platform = await getPlatform();
      const allUserCores = await getPlatformDB().getAllUserCores();

      // Find coreId matching this serverName (could be URL or coreId)
      const cores = await platform.getAllCoreInfos();
      const matchingCore = cores.find(c =>
        c.id === serverName ||
        platform.coreIdToUrl(c.id).includes(serverName)
      );

      if (!matchingCore) {
        return res.json({ users: [] });
      }

      const users = allUserCores
        .filter(uc => uc.coreId === matchingCore.id)
        .map(uc => ({ username: uc.username }));

      res.json({ users });
    } catch (err) {
      next(err);
    }
  });

  /**
   * GET /admin/servers/:src/rename/:dst — rename server (migrate users).
   * In multi-core: updates user-to-core mappings in PlatformDB.
   */
  expressApp.get('/reg/admin/servers/:srcServerName/rename/:dstServerName', checkAdmin, async (req, res, next) => {
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
  expressApp.get('/reg/admin/invitations', checkAdmin, async (req, res, next) => {
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
  expressApp.get('/reg/admin/invitations/post', checkAdmin, async (req, res, next) => {
    try {
      const count = parseInt(req.query.count) || 1;
      const message = req.query.message || '';
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

  async function getCoreUrlForUser (username) {
    const { getPlatform } = require('platform');
    const platform = await getPlatform();

    if (!platform.isSingleCore) {
      const coreId = await platform.getUserCore(username);
      if (coreId != null) {
        return platform.coreIdToUrl(coreId);
      }
    }
    return platform.coreUrl || app.config.get('dnsLess:publicUrl') || 'http://localhost:3000';
  }
};
