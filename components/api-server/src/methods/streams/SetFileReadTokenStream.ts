/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { Transform } = require('stream');
const utils = require('utils');

/**
 * Sets the FileReadToken for each of the given event's attachments (if any) for the given
 * access.
 *
 *        params.access {Object} Access with which the API call was made
 *        params.filesReadTokenSecret {String} available in authSettings
 */
class SetFileReadTokenStream extends Transform {
  access: any;
  filesReadTokenSecret: string;

  constructor (params: any) {
    super({ objectMode: true });
    this.access = params.access;
    this.filesReadTokenSecret = params.filesReadTokenSecret;
  }

  _transform (event: any, encoding: any, callback: any) {
    if (!event.attachments) {
      this.push(event);
    } else {
      event.attachments.forEach((att: any) => {
        att.readToken = utils.encryption.fileReadToken(
          att.id, this.access.id, this.access.token,
          this.filesReadTokenSecret);
      });
      this.push(event);
    }
    callback();
  }
}

export default SetFileReadTokenStream;
export { SetFileReadTokenStream };
