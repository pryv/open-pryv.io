// @flow

const _ = require('lodash');

const middleware = require('components/middleware');

const commonMeta = require('../methods/helpers/setCommonMeta');
const methodCallback = require('./methodCallback');
const Paths = require('./Paths');
const getAuth = require('../../../middleware/src/getAuth');
    
import type Application from '../application';

(async () => {
  await commonMeta.loadSettings();
})();

// Handlers for path roots at various places; handler for batch calls and 
// access-info. 
function root(expressApp: express$Application, app: Application) {
  const settings = app.settings;
  const api = app.api;
  
  const customAuthStepFn = settings.getCustomAuthFunction();
  const initContextMiddleware = middleware.initContext(
    app.storageLayer, customAuthStepFn);
  const loadAccessMiddleware = middleware.loadAccess(app.storageLayer);

  // Bootstrap to user's Pryv page (i.e. browser home).
  expressApp.get('/', rootIndex);
  expressApp.get(Paths.UserRoot + '/', rootIndex);

  // Load user for all user API methods.
  expressApp.all(Paths.UserRoot + '/*', getAuth);
  expressApp.all(Paths.UserRoot + '/*', initContextMiddleware);

  // Current access information.
  expressApp.get(Paths.UserRoot + '/access-info',
    loadAccessMiddleware,
    function (req: express$Request, res, next) {
      // FLOW More request.context...
      api.call('getAccessInfo', req.context, req.query, 
        methodCallback(res, next, 200));
    });

  // Batch request of multiple API method calls.
  expressApp.post(Paths.UserRoot,
    initContextMiddleware,
    loadAccessMiddleware,
    function (req: express$Request, res, next) {
      // FLOW More request.context...
      api.call('callBatch', req.context, req.body, 
        methodCallback(res, next, 200));
    }
  );
}
module.exports = root; 

// Renders a greeting message; this route is displayed on the various forms
// of roots ('/', 'foo.pryv.me/')
// 
function rootIndex(req: express$Request, res) {
  const devSiteURL = 'https://api.pryv.com/';
  const result = commonMeta.setCommonMeta({});
  
  if (req.accepts('application/json')) {
    res.json(_.extend(result, {
      cheersFrom: 'Pryv API',
      learnMoreAt: devSiteURL
    }));
  } else {
    res.send('# Cheers from the Pryv API!\n\n' +
        '- API version: ' + result.meta.apiVersion + '\n' +
        '- Server time: ' + result.meta.serverTime + '\n\n' +
        'Learn more at ' + devSiteURL);
  }
}