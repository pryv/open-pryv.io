// @flow

const express = require('express');
const _ = require('lodash');
const bodyParser = require('body-parser');

const middleware = require('components/middleware');
const errorsMiddlewareMod = require('./middleware/errors'); 

const Paths = require('./routes/Paths');
const config = require('./config');

const { ProjectVersion } = require('components/middleware/src/project_version');


/** Handles requests during application startup. 
 */
function handleRequestDuringStartup(req: express$Request, res: express$Response) {
  res.status(503).send({
    id: 'api-unavailable',
    message: 'The API is temporarily unavailable; please try again in a moment.' });
}

type AirbrakeSettings = {
  projectId: string, key: string,
};

/** Manages our express app during application startup. 
 * 
 * During application startup, this will manage the express application and 
 * allow responding to http requests before we have a database connection. 
 * 
 * Please call these functions in order: 
 *  
 *  * `appStartupBegin`: at the very start of your application; this is called
 *    for you by this file. 
 *  * `appStartupComplete`: When you're ready to server connections, call this 
 *    before adding your routes to express. 
 *  * `routesAdded`: Once all routes are there, call this to add error-handling
 *    middleware. 
 * 
 * @see handleRequestDuringStartup
 */
type Phase = 'init' | 'startupBegon' | 'startupComplete';
class ExpressAppLifecycle {  
  // State for the state machine. 
  phase: Phase;
  
  // The express app. 
  app: express$Application; 
  
  // These are the routes that we add until the startup of the application is 
  // complete. 
  tempRoutes: express$Route; 
  
  // Error handling middleware, injected as dependency. 
  errorHandlingMiddleware: express$Middleware; 
  
  /** Constructs a life cycle manager for an express app. 
   */
  constructor(app: express$Application, errorHandlingMiddleware: express$Middleware) {
    this.app = app; 
    this.errorHandlingMiddleware = errorHandlingMiddleware; 
    this.phase = 'init';
  }
  
  /** Enter the phase given.  
   */
  go(phase: Phase): void {
    const phaseOrder = ['init', 'startupBegon', 'startupComplete'];
    
    const oldIdx = phaseOrder.indexOf(this.phase);
    const newIdx = phaseOrder.indexOf(phase);
    
    if (oldIdx < 0) throw new Error('AF: Old phase invalid.');
    if (newIdx < 0) throw new Error('AF: New phase invalid.');
    if (oldIdx+1 !== newIdx) throw new Error('AF: New phase cannot follow old one.');
    
    this.phase = phase; 
  }

  // ------------------------------------------------------ state machine events
  
  /** Called before we have a database connection. This prevents errors while
   * the boot sequence is in progress. 
   */
  appStartupBegin(): void {
    const app = this.app; 
    
    this.go('startupBegon'); 
    
    // Insert a middleware that allows us to intercept requests. This will 
    // be disabled as soon as `this.phase` is not 'startupBegon' anymore. 
    app.use((req: express$Request, res, next) => {
      if (this.phase === 'startupBegon') {
        handleRequestDuringStartup(req, res);
      }
      else {
        next(); 
      }
    });
  }
  
  // Called once application setup is complete, database and routes and
  // everything.  
  // 
  appStartupComplete() {
    this.go('startupComplete');
    
    const app = this.app; 

    app.use(middleware.notFound);
    app.use(this.errorHandlingMiddleware);
  }
}

// ------------------------------------------------------------ express app init

// Creates and returns an express application with a standard set of middleware. 
// `version` should be the version string you want to show to API clients. 
// 
async function expressAppInit(dependencies: any, isDNSLess: boolean) {
  const pv = new ProjectVersion(); 
  const version = await pv.version(); 

  dependencies.register('airbrakeNotifier', {airbrakeNotifier: createAirbrakeNotifierIfNeeded()});
  
  const commonHeadersMiddleware = middleware.commonHeaders(version);
  const requestTraceMiddleware = dependencies.resolve(middleware.requestTrace); 
  const errorsMiddleware = dependencies.resolve(errorsMiddlewareMod);
  
  var app = express();

  // register common middleware

  app.disable('x-powered-by');

  // Install middleware to hoist the username into the request path. 
  // 
  // NOTE Insert this bit in front of 'requestTraceMiddleware' to also see 
  //  username in logged paths. 
  // 
  const ignorePaths = _.chain(Paths)
    .filter(e => _.isString(e))
    .filter(e => e.indexOf(Paths.Params.Username) < 0)
    .value(); 

  if (! isDNSLess)
    app.use(middleware.subdomainToPath(ignorePaths));

  // Parse JSON bodies: 
  app.use(bodyParser.json({
    limit: '10mb'}));

  // This object will contain key-value pairs, where the value can be a string
  // or array (when extended is false), or any type (when extended is true).
  app.use(bodyParser.urlencoded({
    extended: false}));
    
  // Other middleware:
  app.use(requestTraceMiddleware);
  app.use(middleware.override);
  app.use(commonHeadersMiddleware);

  const lifecycle = new ExpressAppLifecycle(app, errorsMiddleware); 
  return {
    expressApp: app, 
    lifecycle: lifecycle,
  };
}

function createAirbrakeNotifierIfNeeded() {
  
  /*
    Quick guide on how to test Airbrake notifications (under logs entry):
    1. Update configuration file with Airbrake information:
        "airbrake": {
         "active": true,
         "key": "get it from pryv.airbrake.io settings",
         "projectId": "get it from pryv.airbrake.io settings"
       }
    2. Throw a fake error in the code (/routes/root.js is easy to trigger):
        throw new Error('This is a test of Airbrake notifications');
    3. Trigger the error by running the faulty code (run a local core)
   */
  const settings = getAirbrakeSettings(); 
  if (settings == null) return; 

  const { Notifier } = require('@airbrake/node');

  const airbrakeNotifier = new Notifier({
    projectId: settings.projectId,
    projectKey: settings.key,
    environment: 'production',
  });
  return airbrakeNotifier
}

function getAirbrakeSettings(): ?AirbrakeSettings {
  // TODO Directly hand log settings to this class. 
  const logSettings = config.load().logs;
  if (logSettings == null) return null; 
  
  const airbrakeSettings = logSettings.airbrake;
  if (airbrakeSettings == null || !airbrakeSettings.active) return null; 
  
  const projectId = airbrakeSettings.projectId;
  const key = airbrakeSettings.key;
  if (projectId == null || key == null) return null; 
  
  return {
    projectId: projectId, 
    key: key,
  };
}

module.exports = expressAppInit;

export type { ExpressAppLifecycle };
