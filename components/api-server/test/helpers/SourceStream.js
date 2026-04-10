/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
const Readable = require('stream').Readable;
const inherits = require('util').inherits;

module.exports = Source;

/**
 * Readable stream outputing the objects of the array passed in parameters
 *
 * @param array
 * @constructor
 */
function Source (array) {
  Readable.call(this, { objectMode: true });
  this.array = structuredClone(array); // shift changes in place
}

inherits(Source, Readable);

Source.prototype._read = function () {
  if (!this.array || this.array.length === 0) {
    this.push(null);
  } else {
    const reading = this.array.shift();
    this.push(reading);
  }
};
