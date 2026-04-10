/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/**
 * PostgreSQL storage engine plugin.
 *
 * Provides factories for all PostgreSQL-backed storage types.
 * Currently delegates to existing component implementations;
 * code will be physically moved here in a later cleanup phase.
 */

const _internals = require('./_internals');

/**
 * Receive host internals from the barrel.
 * @param {Object} config - Engine-specific configuration from manifest configKey
 * @param {Function} getLogger - Logger factory
 * @param {Object} internals - Map of name → value (remaining host internals)
 */
function init (config, getLogger, internals) {
  _internals.set('config', config);
  _internals.set('getLogger', getLogger);
  for (const [key, value] of Object.entries(internals)) {
    _internals.set(key, value);
  }
}

// -- BaseStorage --------------------------------------------------------

function initStorageLayer (storageLayer, connection, options) {
  const VersionsPG = require('./VersionsPG');
  const PasswordResetRequestsPG = require('./PasswordResetRequestsPG');
  const SessionsPG = require('./SessionsPG');
  const AccessesPG = require('./user/AccessesPG');
  const ProfilePG = require('./user/ProfilePG');
  const StreamsPG = require('./user/StreamsPG');
  const WebhooksPG = require('./user/WebhooksPG');

  storageLayer.connection = connection;
  storageLayer.versions = new VersionsPG(connection, storageLayer.logger);
  storageLayer.passwordResetRequests = new PasswordResetRequestsPG(connection, {
    maxAge: options.passwordResetRequestMaxAge
  });
  storageLayer.sessions = new SessionsPG(connection, { maxAge: options.sessionMaxAge });
  storageLayer.accesses = new AccessesPG(connection, options.integrityAccesses);
  storageLayer.profile = new ProfilePG(connection);
  storageLayer.streams = new StreamsPG(connection);
  storageLayer.webhooks = new WebhooksPG(connection);

  // Events import/clear for backup restore (not used in normal operation —
  // normal event CRUD goes through the DataStore/Mall layer).
  storageLayer.events = {
    importAll (userOrUserId, items, callback) {
      const userId = typeof userOrUserId === 'string' ? userOrUserId : userOrUserId.id;
      if (!items || items.length === 0) return callback(null);

      const COL_MAP = {
        headId: 'head_id',
        streamIds: 'stream_ids',
        endTime: 'end_time',
        clientData: 'client_data',
        createdBy: 'created_by',
        modifiedBy: 'modified_by'
      };
      const JSONB_COLS = new Set(['stream_ids', 'tags', 'content', 'client_data', 'attachments']);
      const mapCol = (prop) => COL_MAP[prop] || prop;
      const mapVal = (col, val) => {
        if (val === undefined) return null;
        if (JSONB_COLS.has(col) && val != null) return JSON.stringify(val);
        return val;
      };

      (async () => {
        for (const event of items) {
          const cols = ['user_id'];
          const vals = [userId];
          const placeholders = ['$1'];
          let idx = 2;

          for (const [prop, val] of Object.entries(event)) {
            const col = prop === 'id' ? 'id' : mapCol(prop);
            cols.push(col);
            vals.push(mapVal(col, val));
            placeholders.push(`$${idx}`);
            idx++;
          }

          await connection.query(
            `INSERT INTO events (${cols.join(', ')}) VALUES (${placeholders.join(', ')}) ON CONFLICT DO NOTHING`,
            vals
          );

          // Populate event_streams junction table
          if (event.streamIds && event.streamIds.length > 0) {
            for (const streamId of event.streamIds) {
              const pathRes = await connection.query(
                'SELECT path FROM streams WHERE user_id = $1 AND id = $2',
                [userId, streamId]
              );
              const streamPath = pathRes.rows.length > 0 ? pathRes.rows[0].path : streamId + '/';
              await connection.query(
                'INSERT INTO event_streams (user_id, event_id, stream_id, stream_path) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING',
                [userId, event.id, streamId, streamPath]
              );
            }
          }
        }
      })().then(() => callback(null)).catch(callback);
    },

    clearAll (userOrUserId, callback) {
      const userId = typeof userOrUserId === 'string' ? userOrUserId : userOrUserId.id;
      (async () => {
        await connection.query('DELETE FROM event_streams WHERE user_id = $1', [userId]);
        await connection.query('DELETE FROM events WHERE user_id = $1', [userId]);
      })().then(() => callback(null)).catch(callback);
    }
  };

  storageLayer.iterateAllEvents = async function * () {
    const { rowToEvent } = require('./dataStore/localUserEventsPG');
    const res = await connection.query('SELECT * FROM events');
    for (const row of res.rows) {
      yield rowToEvent(row);
    }
  };

  storageLayer.getAllUserIdsFromCollection = async function (collectionName) {
    const res = await connection.query(`SELECT DISTINCT user_id FROM ${collectionName}`);
    return res.rows.map(r => r.user_id);
  };

  storageLayer.clearCollection = async function (collectionName) {
    await connection.query(`DELETE FROM ${collectionName}`);
  };
}

function getUserAccountStorage () {
  return require('./userAccountStorage');
}

function getUsersLocalIndex () {
  return require('./usersLocalIndex');
}

// -- DataStore ----------------------------------------------------------

function getDataStoreModule () {
  return require('./dataStore');
}

// -- PlatformStorage ----------------------------------------------------

function createPlatformDB () {
  const DB = require('./DBpostgresql');
  return new DB();
}

// -- SeriesStorage (PostgreSQL) -----------------------------------------

async function createSeriesConnection (config) {
  const PGSeriesConnection = require('./pg_connection');
  // Use provided databasePG (from barrel init) or fall back to storage
  const pgDb = config.databasePG || _internals.databasePG;
  return new PGSeriesConnection(pgDb);
}

// -- AuditStorage (PostgreSQL) ------------------------------------------

function createAuditStorage () {
  const AuditStoragePG = require('./AuditStoragePG');
  const DatabasePG = require('./DatabasePG');
  // Dedicated pool for audit: same DB, smaller pool size to avoid
  // contending with event/stream queries on the main pool.
  const pgConfig = _internals.config;
  const auditDb = new DatabasePG({
    host: pgConfig.host,
    port: pgConfig.port,
    database: pgConfig.database,
    user: pgConfig.user,
    password: pgConfig.password,
    max: pgConfig.auditPoolSize || 5
  });
  return new AuditStoragePG(auditDb);
}

module.exports = {
  init,
  initStorageLayer,
  getUserAccountStorage,
  getUsersLocalIndex,
  getDataStoreModule,
  createPlatformDB,
  createSeriesConnection,
  createAuditStorage
};
