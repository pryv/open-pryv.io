/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { Transform } = require('stream');

/**
 * Some deleted event might have extra properties depending on delete mode.
 * In this eventuality we keep only the id and deleted properties.
 * If we have to modify the structure we also remove the integrity.
 */
class CleanDeletedEventsStream extends Transform {
  constructor () {
    super({ objectMode: true });
  }

  _transform (event, encoding, callback) {
    // we keep integrity only if we keep the full content of the event;
    if (event.time != null) {
      this.push({ id: event.id, deleted: event.deleted });
    } else {
      this.push({ id: event.id, deleted: event.deleted, integrity: event.integrity });
    }
    callback();
  }
}

export default CleanDeletedEventsStream;
export { CleanDeletedEventsStream };
