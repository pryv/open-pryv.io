/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */


import type {} from 'node:fs';

/**
 * Minimal error-factory preserved from the standalone service-mail repo so
 * the ported Sender/Template/TemplateRepository continue to throw the exact
 * same shape. The api-server has its own errors factory; this module stays
 * self-contained on purpose (Pug-rendering concerns only).
 */

class MailError extends Error {
  id: string;
  httpStatus: number;
  data: any;
  constructor (id: string, message: string, status?: number, data?: any) {
    super();
    this.id = id;
    this.message = message;
    this.httpStatus = status || 500;
    this.data = data;
  }
}

const ErrorIds = Object.freeze({
  Forbidden: 'forbidden',
  InvalidRequestStructure: 'invalid-request-structure',
  UnknownResource: 'unknown-resource'
});

module.exports = {
  MailError,
  ErrorIds,
  invalidRequestStructure: (message) => new MailError(ErrorIds.InvalidRequestStructure, message, 400),
  forbidden: (message) => new MailError(ErrorIds.Forbidden, message, 403),
  unknownResource: (message) => new MailError(ErrorIds.UnknownResource, message, 404)
};
