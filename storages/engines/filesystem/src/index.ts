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
import type { Logger } from '@pryv/boiler';
import type { EventFiles as EventFilesT } from '../../../interfaces/fileStorage/EventFiles.ts';
const require = createRequire(import.meta.url);

const { _internals } = require('./_internals.ts');

type ConfigLike = { get: (key: string) => unknown };

/**
 * Receive host internals from the barrel.
 */
function init (config: ConfigLike, getLogger: (name: string) => Logger, internals: Record<string, unknown>): void {
  _internals.set('config', config);
  _internals.set('getLogger', getLogger);
  for (const [key, value] of Object.entries(internals)) {
    _internals.set(key, value);
  }
}

// -- FileStorage --------------------------------------------------------

async function createFileStorage (_config: ConfigLike, _engineInternals: Record<string, unknown>): Promise<EventFilesT> {
  const { EventFiles } = require('./EventLocalFiles.ts');
  return new EventFiles();
}

export { init, createFileStorage };
