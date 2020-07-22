// @flow

const methodCallback = require('./methodCallback');
const Paths = require('./Paths');
const _ = require('lodash');
const middleware = require('components/middleware');

import type Application from '../application';

// Followed slices route handling.
module.exports = function (expressApp: express$Application, app: Application) {
  
  const api = app.api;
  const loadAccessMiddleware = middleware.loadAccess(app.storageLayer);

  // Require access for all FollowedSlices API methods.
  expressApp.all(Paths.FollowedSlices + '*', loadAccessMiddleware);

  expressApp.get(Paths.FollowedSlices, function (req: express$Request, res, next) {
    api.call('followedSlices.get', req.context, req.query, methodCallback(res, next, 200));
  });

  expressApp.post(Paths.FollowedSlices, function (req: express$Request, res, next) {
    api.call('followedSlices.create', req.context, req.body, methodCallback(res, next, 201));
  });

  expressApp.put(Paths.FollowedSlices + '/:id', function (req: express$Request, res, next) {
    api.call('followedSlices.update', req.context, { id: req.params.id, update: req.body },
      methodCallback(res, next, 200));
  });

  expressApp.delete(Paths.FollowedSlices + '/:id', function (req: express$Request, res, next) {
    api.call('followedSlices.delete', req.context, _.extend({ id: req.params.id }, req.query),
      methodCallback(res, next, 200));
  });

};
