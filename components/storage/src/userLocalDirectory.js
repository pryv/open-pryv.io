/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/**
 * ToolSet to manipulate User's local directory
 */

const path = require('path');
const fs = require('fs/promises');
const mkdirp = require('mkdirp');

const { getConfig } = require('@pryv/boiler');

module.exports = {
  init,
  ensureUserDirectory,
  getPathForUser,
  deleteUserDirectory,
  getBasePath,
  setBasePathTestOnly
};

let config;
let basePath;

// temporarly set baseBath for tests;
function setBasePathTestOnly (path) {
  basePath = path || config.get('storages:engines:sqlite:path');
}

/**
 * Load config and make sure baseUserDirectory exists
 * This could also handle eventual migrations
 */
async function init () {
  if (basePath) return;
  config = await getConfig();
  const candidateBasePath = config.get('storages:engines:sqlite:path');
  if (!candidateBasePath || candidateBasePath === 'REPLACE ME') {
    throw new Error('storages:engines:sqlite:path is not configured (still "REPLACE ME"). Load the paths-config plugin or set an explicit path.');
  }
  mkdirp.sync(candidateBasePath);
  basePath = candidateBasePath;
}

/**
 * Return and **creates** the desired user path
 * @param {string} userId -- user id (cuid format)
 * @param {string} [extraPath] -- Optional, extra path
 */
async function ensureUserDirectory (userId, extraPath = '') {
  const resultPath = getPathForUser(userId, extraPath);
  await mkdirp(resultPath); // ensures directory exists
  return resultPath;
}

/**
 * Return the local storage for this user. (does not create it)
 * @param {string} userId -- user id (cuid format)
 * @param {string} [extraPath] -- Optional, extra path
 */
function getPathForUser (userId, extraPath = '') {
  if (basePath == null) {
    throw new Error('Run init() first');
  }
  if (!userId || userId.length < 3) {
    throw new Error('Invalid or too short userId: ' + userId);
  }
  const dir1 = userId.substr(userId.length - 1, 1); // last character of id
  const dir2 = userId.substr(userId.length - 2, 1);
  const dir3 = userId.substr(userId.length - 3, 1);
  const resultPath = path.join(basePath, dir1, dir2, dir3, userId, extraPath);
  return resultPath;
}

/**
 * Delete user data folder
 *
 * @param {*} userId -- user id
 */
async function deleteUserDirectory (userId) {
  const userFolder = getPathForUser(userId);
  await fs.rm(userFolder, { recursive: true, force: true });
}

function getBasePath () {
  if (basePath == null) {
    throw new Error('Initialize UserLocalDirectory first');
  }
  return basePath;
}
