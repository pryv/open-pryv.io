/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const Transform = require('stream').Transform;

// serialize every n objects
const OBJECT_BUFFER_SIZE = 100;
// event if OBJECT_BUFFER_SIZE is not reach, serialize if MAX_WAIT_MS is reached
const MAX_WAIT_MS = 100;

/**
 * Stream that encapsulates the items it receives in a stringified array.
 *
 * @param arrayName {String} array name that will prefix the array
 */
class ArraySerializationStream extends Transform {
  constructor (arrayName: any) {
    super({ writableObjectMode: true });
    this.isStart = true;
    this.prefix = '"' + arrayName + '":';
    this.size = OBJECT_BUFFER_SIZE;
    this.stack = [];
    this.lastSerialization = Date.now();
  }

  _transform (item: any, encoding: any, callback: any) {
    this.stack.push(item);

    if (this.stack.length >= this.size || (Date.now() - this.lastSerialization) > MAX_WAIT_MS) {
      if (this.isStart) {
        this.isStart = false;
        this.push((this.prefix + JSON.stringify(this.stack)).slice(0, -1));
      } else {
        this.push(',' + (JSON.stringify(this.stack)).slice(1, -1));
      }
      this.lastSerialization = Date.now();
      this.stack = [];
    }
    callback();
  }

  _flush = function (this: any, callback: any) {
    if (this.isStart) {
      this.push(this.prefix + JSON.stringify(this.stack));
    } else {
      const joiningComma = this.stack.length > 0 ? ',' : '';
      this.push(joiningComma + (JSON.stringify(this.stack)).slice(1));
    }
    this.push(',');
    callback();
  };
}
export default ArraySerializationStream;
export { ArraySerializationStream };
