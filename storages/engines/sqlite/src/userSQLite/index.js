/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
const Storage = require('./Storage');

module.exports = {
  getStorage,
  closeStorage
};

const storages = {};
/**
 *@returns {Promise<Storage>}
 */
async function getStorage (name) {
  if (!storages[name]) {
    storages[name] = new Storage(name);
    await storages[name].init();
  }
  return storages[name];
}

function closeStorage (name) {
  if (storages[name]) {
    storages[name].close();
    delete storages[name];
  }
}
