// @flow

const model = require('components/model');
const MethodContext = model.MethodContext;

import type { CustomAuthFunction } from 'components/model';
import type { StorageLayer } from 'components/storage';


// Returns a middleware function that initializes the method context into
// `req.context`. The context is initialized with the user (loaded from
// username) and the access token. the access itself is **not** loaded from
// token here as it may be modified in the course of method execution, for
// example when calling a batch of methods. it is the api methods'
// responsibility to load the access when needed. 
// 
module.exports = function initContext(
  storageLayer: StorageLayer, customAuthStepFn: ?CustomAuthFunction
) {
  return function (
    req: express$Request, res: express$Response, next: express$NextFunction
  ) {
    const authorizationHeader = req.headers['authorization'];


    // FLOW We should not do this, but we're doing it.
    req.context = new MethodContext(
      req.params.username,
      authorizationHeader, 
      customAuthStepFn);
    
    const userRetrieved = req.context.retrieveUser(storageLayer);
    
    // Convert the above promise into a callback. 
    return userRetrieved.then(() => next()).catch(next);
  };
};
