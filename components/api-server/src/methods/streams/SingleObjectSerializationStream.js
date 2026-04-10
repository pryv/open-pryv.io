/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
const Transform = require('stream').Transform;

/**
 * Stream that serialize the first object it receives.
 *
 * @param objectName {String} array name that will prefix the array
 * @constructor
 */
module.exports = class SingleObjectSerializationStream extends Transform {
  name;
  constructor (objectName) {
    super({ writableObjectMode: true });
    this.name = objectName;
  }

  _transform = function (item, encoding, callback) {
    this.push('"' + this.name + '": ' + JSON.stringify(item) + ', ');
    callback();
  };

  _flush = function (callback) {
    callback();
  };
};
