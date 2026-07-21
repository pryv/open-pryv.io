/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */


type APIErrorOptions = {
  httpStatus?: number;
  data?: unknown;
  innerError?: Error | null;
};

/**
 * The constructor to use for all errors within the API.
 */
class APIError extends Error {
  id: string;
  httpStatus: number;
  data: unknown;
  innerError: Error | null;
  /**
   * Optional response headers the http error layer must emit with this
   * error (e.g. a WWW-Authenticate challenge). Never part of the JSON
   * body.
   */
  httpHeaders?: Record<string, string>;

  constructor (id: string, message: string, options?: APIErrorOptions) {
    super(message);

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

export { APIError };
export type { APIErrorOptions };
