/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
import { Transform } from 'node:stream';

type StreamReadCheck = { canGetEventsOnStream (streamId: string, storeId: string): Promise<boolean> };

/**
 * Keeps the event deletion records the access can read: those whose kept
 * `streamIds` include a stream readable by it. A record without streams (every
 * deletion mode but keep-everything) is dropped.
 */
class ReadableDeletionsStream extends Transform {
  access: StreamReadCheck;

  constructor (access: StreamReadCheck) {
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
    for (const streamId of event.streamIds ?? []) {
      if (await this.access.canGetEventsOnStream(streamId, 'local')) return true;
    }
    return false;
  }
}

export default ReadableDeletionsStream;
export { ReadableDeletionsStream };
