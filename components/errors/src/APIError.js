/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/**
 * The constructor to use for all errors within the API.
 */
class APIError extends Error {
  id;
  message;
  httpStatus;
  data;
  innerError;

  constructor (id, message, options) {
    super();

    this.id = id;
    this.message = message;

    this.httpStatus = 500;
    if (options != null && options.httpStatus != null) { this.httpStatus = options.httpStatus; }

    this.data = null;
    if (options != null && options.data != null) { this.data = options.data; }

    this.innerError = null;
    if (options != null && options.innerError != null) { this.innerError = options.innerError; }
  }
}

module.exports = APIError;

/**
 * @typedef {{
 *   httpStatus?: number;
 *   data?: unknown;
 *   innerError?: Error | null;
 * }} APIErrorOptions
 */
