// @flow

const methodCallback = require('./methodCallback');
const Paths = require('./Paths');
const tryCoerceStringValues = require('../schema/validation').tryCoerceStringValues;
const _ = require('lodash');
const middleware = require('components/middleware');

import type Application from '../application';

// Event streams route handling.
module.exports = function (expressApp: express$Application, app: Application) {

  const api = app.api;
  const loadAccessMiddleware = middleware.loadAccess(app.storageLayer);

  // Require access for all Streams API methods.
  expressApp.all(Paths.Streams + '*', loadAccessMiddleware);

  expressApp.get(Paths.Streams, function (req: express$Request, res, next) {
    var params = _.extend({}, req.query);
    tryCoerceStringValues(params, {
      includeDeletionsSince: 'number'
    });
    api.call('streams.get', req.context, params, methodCallback(res, next, 200));
  });

  expressApp.post(Paths.Streams, function (req: express$Request, res, next) {
    api.call('streams.create', req.context, req.body, methodCallback(res, next, 201));
  });

  expressApp.put(Paths.Streams + '/:id', function (req: express$Request, res, next) {
    api.call('streams.update', req.context, { id: req.params.id, update: req.body },
      methodCallback(res, next, 200));
  });

  expressApp.delete(Paths.Streams + '/:id', function (req: express$Request, res, next) {
    var params = _.extend({id: req.params.id}, req.query);
    tryCoerceStringValues(params, {
      mergeEventsWithParent: 'boolean'
    });
    api.call('streams.delete', req.context, params,
      methodCallback(res, next, 200));
  });

};
