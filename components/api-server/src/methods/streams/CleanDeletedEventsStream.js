/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
const Transform = require('stream').Transform;
const inherits = require('util').inherits;

module.exports = CleanDeletedEventsStream;

/**
 * Some deleted event might have extra properties depending on delete mode
 * In this eventuality we keep only the id and deleted properties.
 * If we have to modify the structure we also remove the integrity.
 * @constructor
 */
function CleanDeletedEventsStream () {
  Transform.call(this, { objectMode: true });
}

inherits(CleanDeletedEventsStream, Transform);

CleanDeletedEventsStream.prototype._transform = function (event, encoding, callback) {
  // we keep integrity only if keep the full content of the event;
  if (event.time != null) {
    this.push({ id: event.id, deleted: event.deleted });
  } else {
    this.push({ id: event.id, deleted: event.deleted, integrity: event.integrity });
  }
  callback();
};
