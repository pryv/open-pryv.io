/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
import type {} from 'node:fs';

const methodCallback = require('api-server/src/routes/methodCallback');
const Paths = require('api-server/src/routes/Paths');
const middleware = require('middleware');
const { setMethodId } = require('middleware');
const tryCoerceStringValues = require('api-server/src/schema/validation').tryCoerceStringValues;
// Event streams route handling.
module.exports = function (expressApp, app) {
  const api = app.api;
  const loadAccessMiddleware = middleware.loadAccess(app.storageLayer);
  expressApp.get(Paths.Audit, setMethodId('audit.getLogs'), loadAccessMiddleware, function (req, res, next) {
    const params = Object.assign({}, req.query);
    tryCoerceStringValues(params, {
      // standard event type
      fromTime: 'number',
      toTime: 'number',
      streams: 'object',
      types: 'array',
      sortAscending: 'boolean',
      skip: 'number',
      limit: 'number',
      modifiedSince: 'number'
    });
    api.call(req.context, params, methodCallback(res, next, 200));
  });
};
