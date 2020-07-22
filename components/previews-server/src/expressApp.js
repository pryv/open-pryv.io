// @flow

const express = require('express');
const middleware = require('components/middleware');
const bodyParser = require('body-parser');

type AppAndEndWare = {
  expressApp: express$Application, 
  routesDefined: () => mixed, 
}

/**
 * The Express app definition.
 */
module.exports = function expressApp(
  commonHeadersMiddleware: express$Middleware,
  errorsMiddleware: express$Middleware,
  requestTraceMiddleware: express$Middleware
): AppAndEndWare {
  const app = express();

  /** Called once routes are defined on app, allows finalizing middleware stack
   * with things like error handling.
   **/
  function routesDefined() {
    app.use(errorsMiddleware);
  }

  app.disable('x-powered-by');

  app.use(middleware.subdomainToPath([]));

  app.use(requestTraceMiddleware);
  app.use(bodyParser.json());
  app.use(commonHeadersMiddleware);

  return {
    expressApp: app,
    routesDefined: routesDefined,
  };
};
module.exports.injectDependencies = true;
