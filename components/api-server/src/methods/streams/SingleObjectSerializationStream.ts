/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const Transform = require('stream').Transform;

/**
 * Stream that serialize the first object it receives.
 *
 * @param objectName {String} array name that will prefix the array
 */
class SingleObjectSerializationStream extends Transform {
  name;
  constructor (objectName: any) {
    super({ writableObjectMode: true });
    this.name = objectName;
  }

  _transform = function (this: any, item: any, encoding: any, callback: any) {
    this.push('"' + this.name + '": ' + JSON.stringify(item) + ', ');
    callback();
  };

  _flush = function (callback: any) {
    callback();
  };
}
export default SingleObjectSerializationStream;
export { SingleObjectSerializationStream };
