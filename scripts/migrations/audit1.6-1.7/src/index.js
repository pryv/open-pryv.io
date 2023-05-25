/**
 * @license
 * Copyright (C) 2020–2023 Pryv S.A. https://pryv.com
 *
 * This file is part of Open-Pryv.io and released under BSD-Clause-3 License
 *
 * Redistribution and use in source and binary forms, with or without
 * modification, are permitted provided that the following conditions are met:
 *
 * 1. Redistributions of source code must retain the above copyright notice,
 *   this list of conditions and the following disclaimer.
 *
 * 2. Redistributions in binary form must reproduce the above copyright notice,
 *   this list of conditions and the following disclaimer in the documentation
 *   and/or other materials provided with the distribution.
 *
 * 3. Neither the name of the copyright holder nor the names of its contributors
 *   may be used to endorse or promote products derived from this software
 *   without specific prior written permission.
 *
 * THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS"
 * AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE
 * IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
 * DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE
 * FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL
 * DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR
 * SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER
 * CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY,
 * OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
 * OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
 *
 * SPDX-License-Identifier: BSD-3-Clause
 */
const MongoClient = require('../../../../node_modules/mongodb').MongoClient;

const Router = require('../../../../node_modules/express').Router;
/// Load all Routes in a fake Express
const ROUTES = require('./routes');

const fs = require('fs');
const path = require('path');
const lineReader = require('line-reader');

const rootPath = '../../../../';

// ---------------- CONFIG ----------//

const { getConfig, getLogger } = require(rootPath + 'node_modules/@pryv/boiler').init({
  appName: 'audit-migration',
  baseFilesDir: path.resolve(__dirname, '../../../../'),
  baseConfigDir: path.resolve(__dirname, rootPath + 'components/api-server/config'),
  extraConfigs: [{
    scope: 'default-paths',
    file: path.resolve(__dirname, rootPath + 'components/api-server/config/paths-config.js')
  }, {
    scope: 'default-audit',
    file: path.resolve(__dirname, rootPath + 'components/audit/config/default-config.yml')
  }, {
    scope: 'default-audit-path',
    file: path.resolve(__dirname, rootPath + 'components/audit/config/default-path.js')
  }]
});

const logger = getLogger();

const audit = require(rootPath + 'components/audit');
const userLocalDirectory = require(rootPath + 'components/business/src/users/userLocalDirectory');

// ---------------- username => ID ---------------//

async function userIdForusername (username) {
  const res = await db.collection('events').findOne(
    {
      $and: [
        {
          streamIds: {
            $in: [':_system:username']
          }
        },
        { content: { $eq: username } }
      ]
    });
  if (!res) return null;
  return res.userId;
}

function connectToMongo () {
  const dbconf = config.get('database');
  const mongoConnectString = `mongodb://${dbconf.host}:${dbconf.port}/`;
  return new Promise((resolve, reject) => {
    MongoClient.connect(mongoConnectString, { useUnifiedTopology: true }, (err, client) => {
      if (err) return reject(err);
      resolve(client.db(dbconf.name));
    });
  });
}

// -------------- FILES AND DIR (AUDIT) ------------ //

async function listDirectory (logDiretory) {
  return new Promise((resolve, reject) => {
    fs.readdir(logDiretory, { withFileTypes: true }, (err, fileTypes) => {
      if (err) return reject(err);
      resolve(fileTypes.filter(f => f.isDirectory()).map(d => d.name));
    });
  });
}

// in reverse order !!
function listAuditFilesForUser (username) {
  function getLogN (filname) {
    const s = filname.split('.');
    return parseInt(s[2]) || 0;
  }

  return new Promise((resolve, reject) => {
    const userDir = path.resolve(audiLogsDirs, username);
    fs.readdir(userDir, { withFileTypes: true }, (err, fileTypes) => {
      if (err) return reject(err);
      resolve(fileTypes
        .filter(f => !f.isDirectory() && f.name.startsWith('audit.log'))
        .map(d => d.name)
        .sort((first, second) => {
          return getLogN(second) - getLogN(first);
        }));
    });
  });
}

function readFile (username, filename) {
  const file = path.resolve(audiLogsDirs, username, filename);

  return new Promise((resolve, reject) => {
    if (fs.statSync(file).size === 0) {
      logger.info(file + ' => is empty');
      return resolve();
    }

    const count = 0;
    let lineCount = 0;
    lineReader.eachLine(file, function (line, last, cb) {
      lineCount++;
      let item;
      try {
        item = eventFromLine(line, username);
        if (item) {
          storeEvent(username, item);
        }
      } catch (e) {
        // eslint-disable-next-line n/no-callback-literal
        cb(false);
        reject(new Error('Error on file ' + file + ':' + lineCount + ' >>> ' + e.message + '\n' + line));
        return;
      }
      if (!item) {
        // count++;
      }
      if (last) resolve();
      if (count > 10) {
        // eslint-disable-next-line n/no-callback-literal
        cb(false);
        resolve();
        return;
      }
      cb();
    });
  });
}

async function readLogs (username) {
  const files = await listAuditFilesForUser(username);
  for (const file of files) {
    try {
      await readFile(username, file);
    } catch (e) {
      logger.info(e);
      process.exit(1);
    }
    logger.info(file, userAnchor[username]);
  }
  logger.info('done', userAnchor[username]);

  // logger.info(files);
}

// ---------  EVENTS AND CONVERTERS ------------------------//

function storeEvent (username, event) {
  userStorageByUsername[username].createEventSync(event);
}

// Load routes in a fake expressRouter
const router = Router();

const IGNORES = [
  { methodId: false, path: '/:username/robots.txt', method: 'get' },
  { methodId: false, path: '/:username/favicon.ico', method: 'get' },
  { methodId: false, path: '/:username/socket.io', method: 'get' }
];

for (const r of ROUTES.concat(IGNORES)) {
  if (r.methodId !== undefined) { router[r.method](r.path, (req, res, next) => { res.methodId = r.methodId; }); }
}

router.get('/*', (req, res, next) => { logger.info('IGNORED>', req.url, req.method); next(); });

const NOUSERNAME = ['/reg/', '/register/', '/system/'];
function addUserNameIfNeeded (saction, username) {
  for (const n of NOUSERNAME) {
    if (saction[1].startsWith(n)) return;
  }
  if (!saction[1].startsWith('/' + username)) saction[1] = '/' + username + saction[1];
}

function methodIdForAction2 (action, username) {
  const saction = action.split(' ');
  if (saction[0] === 'OPTIONS') return null;
  // add username if needed
  addUserNameIfNeeded(saction, username);
  const myRes = {};
  router.handle({ url: saction[1], method: saction[0] }, myRes, function () { });
  // logger.info('******', saction, myRes);
  return myRes.methodId;
}

const errors = [];

const INCOMING_REQUEST = 'Incoming request. Details: ';
const RESULT_LINE = ' Details: ';
const RESULT_LINE_L = RESULT_LINE.length - 1;
function eventFromLine (line, username) {
  if (line.indexOf(INCOMING_REQUEST) > 0) {
    // logger.info(line);
    return false; // skip
  }
  if (line.indexOf('message repeated') > 0 && line.indexOf('times: [') > 0) return false;

  const detailPos = line.indexOf(RESULT_LINE);
  if (detailPos < 0) {
    console.error('beginning of data anchor "Details:" not found');
    errors.push({
      username,
      line,
      reason: 'beginning of data anchor "Details:" not found'
    });
    return false;
  }

  let data;
  try {
    data = JSON.parse(line.substr(detailPos + RESULT_LINE_L));
  } catch (err) {
    console.error('unable to parse JSON at', line);
    errors.push({
      username,
      line,
      reason: 'unable to parse JSON'
    });
    return false;
  }

  if (data.iso_date == null) {
    console.error('iso_data missing at', line);
    errors.push({
      username,
      line,
      reason: 'iso_data missing'
    });
    return false;
  }

  const time = (new Date(data.iso_date)).getTime() / 1000;
  if (time <= userAnchor[username].lastSync) {
    userAnchor[username].skip++;
    return false;
  }
  // logger.info('===', time, userAnchor[username].lastSync, time - userAnchor[username].lastSync, userAnchor[username]);
  userAnchor[username].count++;

  const methodId = methodIdForAction2(data.action, username);
  if (!methodId) {
    return false; // skip
  }

  const event = {
    createdBy: 'migration',
    streamIds: [audit.CONSTANTS.ACTION_STREAM_ID_PREFIX + methodId],
    type: audit.CONSTANTS.EVENT_TYPE_VALID,
    time,
    content: {
      source: {
        name: 'http',
        ip: data.forwarded_for
      },
      action: methodId,
      query: data.query
    }
  };
  if (data.access_id) {
    event.streamIds.push(audit.CONSTANTS.ACCESS_STREAM_ID_PREFIX + data.access_id);
  }

  if (data.error_id) {
    event.type = audit.CONSTANTS.EVENT_TYPE_ERROR;
    event.content.id = data.error_id;
    event.content.message = '';
  }

  // logger.info(event);
  return event;
}

// -----------  Anchor --------- //

function getLastSynchedItem (username) {
  const res = userStorageByUsername[username].getEvents({ limit: 1, sortAscending: false, createdBy: 'migration' });
  if (res[0] && res[0].time) {
    userAnchor[username].lastSync = res[0].time;
  }
}

// --------- Arguments ------ //

async function getAuditLogDir () {
  const path = process.argv[2];
  if (!path || !fs.lstatSync(path).isDirectory()) {
    logger.error('Error: ' + path + ' is not a directory');
    logger.info('Usage: node src/index.js <path to audit log dir (/var/log/pryv/audit/pryvio_core)>');
    process.exit(1);
  }
  return path;
}

let db; let config; let audiLogsDirs; const userIdMap = {}; const userStorageByUsername = {}; const userAnchor = {};
async function start () {
  config = await getConfig();
  if (config.get('openSource:isActive') || (!config.get('audit:active'))) {
    logger.info('Skipping Migration Audit is not active');
  }
  await audit.init();
  await userLocalDirectory.init();
  audiLogsDirs = await getAuditLogDir();

  db = await connectToMongo();
  const usernames = await listDirectory(audiLogsDirs);
  for (const username of usernames) {
    const uid = await userIdForusername(username);
    if (!uid) {
      logger.error('Cannot find UID for: ' + username);
      continue;
    }
    userIdMap[username] = uid;
    userStorageByUsername[username] = await audit.storage.forUser(uid);
    userAnchor[username] = { lastSync: 0, skip: 0, count: 0 };
    getLastSynchedItem(username);
    const synchInfo = userAnchor[username].lastSync ? (new Date(userAnchor[username].lastSync * 1000)) : '-';
    logger.info('GO>', username, uid, synchInfo);
    await readLogs(username);
    delete userStorageByUsername[username];
  }
}

(async () => {
  await start();
  console.log('finished migration.');
  if (errors.length > 0) console.log('errors:', JSON.stringify(errors, null, 2));
  process.exit(0);
})();
