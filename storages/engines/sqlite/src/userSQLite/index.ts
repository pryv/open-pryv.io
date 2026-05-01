/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
import type {} from 'node:fs';

const Storage = require('./Storage');

module.exports = {
  getStorage,
  closeStorage
};

const storages: Record<string, any> = {};

async function getStorage (name: string): Promise<any> {
  if (!storages[name]) {
    storages[name] = new Storage(name);
    await storages[name].init();
  }
  return storages[name];
}

function closeStorage (name: string): void {
  if (storages[name]) {
    storages[name].close();
    delete storages[name];
  }
}
