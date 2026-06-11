/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/**
 * S3-compatible object storage engine plugin.
 *
 * Provides event file attachment storage on AWS S3 / MinIO / Ceph RGW /
 * any S3-compatible store — the diskless alternative to the filesystem
 * engine. Select with `storages.file.engine: s3` + a
 * `storages.engines.s3` configuration block.
 */

import { createRequire } from 'node:module';
import type { Logger } from '@pryv/boiler';
import type { EventFiles as EventFilesT } from '../../../interfaces/fileStorage/EventFiles.ts';
const require = createRequire(import.meta.url);

const { _internals } = require('./_internals.ts');

/**
 * Receive host internals from the barrel.
 */
function init (config: Record<string, unknown>, getLogger: (name: string) => Logger, internals: Record<string, unknown>): void {
  _internals.set('config', config);
  _internals.set('getLogger', getLogger);
  for (const [key, value] of Object.entries(internals || {})) {
    _internals.set(key, value);
  }
}

// -- FileStorage --------------------------------------------------------

async function createFileStorage (): Promise<EventFilesT> {
  const { EventS3Files } = require('./EventS3Files.ts');
  return new EventS3Files();
}

export { init, createFileStorage };
