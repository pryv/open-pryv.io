/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/**
 * Filesystem storage engine plugin.
 *
 * Provides local filesystem-based event file attachment storage.
 * Currently delegates to existing EventLocalFiles implementation;
 * code will be physically moved here in a later cleanup phase.
 */

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

const { _internals } = require('./_internals');

/**
 * Receive host internals from the barrel.
 */
function init (config: Record<string, any>, getLogger: (name: string) => any, internals: Record<string, any>): void {
  _internals.set('config', config);
  _internals.set('getLogger', getLogger);
  for (const [key, value] of Object.entries(internals)) {
    _internals.set(key, value);
  }
}

// -- FileStorage --------------------------------------------------------

async function createFileStorage (_config: any, _engineInternals: any): Promise<any> {
  const { EventFiles } = require('./EventLocalFiles');
  return new EventFiles();
}

export { init, createFileStorage };
