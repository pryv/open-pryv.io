// @flow

const errors = require('components/errors').factory;
    
// NOTE Name chosen to be unwieldy, so as not to make this look too good. 
declare class RequestWithOriginalMethodAndBody extends express$Request { 
  originalMethod: ?string;
  originalBody: any;
}

/**
 * Middleware to allow overriding HTTP method, "Authorization" header and JSON
 * body content by sending them as fields in urlencoded requests. Does not
 * perform request body parsing (expects req.body to exist), so must be executed
 * after e.g. bodyParser middleware.
 */
function normalizeRequest(
  req: RequestWithOriginalMethodAndBody, 
  res: express$Response, 
  next: express$NextFunction) 
{
  if (! req.is('application/x-www-form-urlencoded')) { return next(); }
  
  const body = req.body; 
  if (body == null || typeof body !== 'object') return next();

  if (typeof body._method == 'string') {
    req.originalMethod = req.originalMethod || req.method;
    req.method = body._method.toUpperCase();
    delete body._method;
  }

  if (body._auth) {
    if (req.headers.authorization) {
      req.headers['original-authorization'] = req.headers.authorization;
    }
    req.headers.authorization = body._auth;
    delete body._auth;
  }

  if (typeof body._json === 'string') {
    req.originalBody = req.originalBody || body;
    try {
      req.body = JSON.parse(body._json);
    } catch (err) {
      return next(errors.invalidRequestStructure(err.message));
    }
  }

  next();
}

module.exports = normalizeRequest;