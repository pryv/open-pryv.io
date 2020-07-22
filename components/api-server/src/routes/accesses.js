// @flow

const methodCallback = require('./methodCallback');
const Paths = require('./Paths');
const _ = require('lodash');
const middleware = require('components/middleware');

import type Application from '../application';

// Shared accesses route handling.
module.exports = function (expressApp: express$Application, app: Application) {

  const api = app.api;
  const loadAccessMiddleware = middleware.loadAccess(app.storageLayer);

  // Require access for all Accesses API methods.
  expressApp.all(Paths.Accesses + '*', loadAccessMiddleware);

  expressApp.get(Paths.Accesses, function (req: express$Request, res, next) {
    api.call('accesses.get', req.context, req.query, methodCallback(res, next, 200));
  });

  expressApp.post(Paths.Accesses, function (req: express$Request, res, next) {
    api.call('accesses.create', req.context, req.body, methodCallback(res, next, 201));
  });

  expressApp.put(Paths.Accesses + '/:id', function (req: express$Request, res, next) {
    var params = { id: req.params.id, update: req.body };
    api.call('accesses.update', req.context, params, methodCallback(res, next, 200));
  });

  expressApp.delete(Paths.Accesses + '/:id', function (req: express$Request, res, next) {
    var params = _.extend({id: req.params.id}, req.query);
    api.call('accesses.delete', req.context, params, methodCallback(res, next, 200));
  });

  expressApp.post(Paths.Accesses + '/check-app', function (req: express$Request, res, next) {
    api.call('accesses.checkApp', req.context, req.body, methodCallback(res, next, 200));
  });

};
