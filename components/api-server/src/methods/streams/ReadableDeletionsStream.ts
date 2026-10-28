/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
import { createRequire } from 'node:module';
import { Transform } from 'node:stream';
import type { CanReadEventAccess } from 'business/src/accesses/canReadEvent.ts';
const require = createRequire(import.meta.url);
const { canReadEvent } = require('business/src/accesses/canReadEvent.ts');

/**
 * Keeps the event deletion records the access can read: the ones whose kept
 * `streamIds` the access could read as a live event (one stream readable, none
 * withheld from it by a `none` / `create-only` grant, forced streams honoured).
 * A record without streams (every deletion mode but keep-everything) is dropped.
 */
class ReadableDeletionsStream extends Transform {
  access: CanReadEventAccess;

  constructor (access: CanReadEventAccess) {
    super({ objectMode: true });
    this.access = access;
  }

  _transform (event: { streamIds?: string[] }, encoding: BufferEncoding, callback: (error?: Error | null) => void) {
    this.isReadable(event).then((readable) => {
      if (readable) this.push(event);
      callback();
    }, callback);
  }

  async isReadable (event: { streamIds?: string[] }): Promise<boolean> {
    return await canReadEvent(this.access, event);
  }
}

export default ReadableDeletionsStream;
export { ReadableDeletionsStream };
