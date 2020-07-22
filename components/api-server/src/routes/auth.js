// @flow

const cookieParser = require('cookie-parser');
const lodash = require('lodash');
const express = require('express');

const errors = require('components/errors').factory;
const middleware = require('components/middleware');

const methodCallback = require('./methodCallback');
const Paths = require('./Paths');

declare class RequestWithContext extends express$Request {
  context: any; 
}


import type { ConfigAccess } from '../settings';
import type Application from '../application';

/**
 * Auth routes.
 *
 * @param {Object} api The API object for registering methods
 */
module.exports = function (expressApp: express$Application, app: Application) {

  const settings: ConfigAccess = app.settings;
  const api = app.api;

  const ms14days: number = 1000 * 60 * 60 * 24 * 14;
  const sessionMaxAge: number = settings.get('auth.sessionMaxAge').num() || ms14days;
  const ssoCookieDomain: string = settings.get('auth.ssoCookieDomain').str() || settings.get('http.ip').str();
  const ssoCookieSignSecret: string = settings.get('auth.ssoCookieSignSecret').str() || 'Hallowed Be Thy Name, O Node';
  const ssoCookieSecure: boolean = process.env.NODE_ENV !== 'development' && process.env.NODE_ENV !== 'test' ;
  const ssoIsWhoamiActivated: boolean = settings.get('deprecated.auth.ssoIsWhoamiActivated').bool();
  const ssoHttpOnly: boolean = true ;

  const loadAccessMiddleware = middleware.loadAccess(app.storageLayer);

  // Returns true if the given `obj` has all of the property values identified
  // by the names contained in `keys`.
  //
  function hasProperties(obj: mixed, keys: Array<string>): boolean {
    if (obj == null) { return false; }
    if (typeof obj !== 'object') { return false; }
    
    for (const key of keys) {
      if (! lodash.has(obj, key)) return false; 
    }
    return true; 
  }

  function setSSOCookie(data: Object, res) {
    res.cookie('sso', data, {
      domain: ssoCookieDomain,
      maxAge: sessionMaxAge,
      secure: ssoCookieSecure,
      signed: true,
      httpOnly: ssoHttpOnly
    });
  }
  function clearSSOCookie(res) {
    res.clearCookie('sso', {
      domain: ssoCookieDomain,
      secure: ssoCookieSecure,
      httpOnly: ssoHttpOnly
    });
  }
  function defineRoutes(router) {
    // Define local routes
    router.all('*', cookieParser(ssoCookieSignSecret));
    router.get('/who-am-i', function routeWhoAmI(req: express$Request, res, next) {
      if (! ssoIsWhoamiActivated) {
        return next(errors.unknownResource());
      }

      var ssoCookie = req.signedCookies.sso;


      if (! ssoCookie || typeof ssoCookie !== 'object') {
        return next(errors.invalidCredentials('Not signed-on'));
      }

      res.status(200).json({
        username: ssoCookie.username,
        token: ssoCookie.token
      });
    });
    router.post('/login', function routeLogin(req: RequestWithContext, res, next) {
      if (typeof req.body !== 'object' || req.body == null ||
        ! hasProperties(req.body, ['username', 'password', 'appId'])) {
        return next(errors.invalidOperation('Missing parameters: username, password and appId are required.'));
      }
      const body: Object = req.body; 
      
      var params = {
        username: body.username,
        password: body.password,
        appId: body.appId,
        // some browsers provide origin, some provide only referer
        origin: req.headers.origin || req.headers.referer || ''
      };
      
      api.call('auth.login', req.context, params, function (err, result) {
        if (err) return next(err);
        setSSOCookie({ username: req.context.username, token: result.token }, res);
        result.writeToHttpResponse(res, 200);
      });

    });
    router.post('/logout',
      loadAccessMiddleware,
      function routeLogout(req: RequestWithContext, res, next) {
        clearSSOCookie(res);
        api.call('auth.logout', req.context, {}, methodCallback(res, next, 200));
      });
  }
  
  // Create a router that is relative to /:username/auth/
  const router = express.Router(); 
  expressApp.use(Paths.Auth, router);
  
  defineRoutes(router);
  
  return {
    hasProperties: hasProperties, 
  };
};
