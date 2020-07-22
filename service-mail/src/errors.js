
/**
 * The constructor to use for all errors within the API.
 */
class APIError extends Error {
  
  constructor(id, message, status, data) {
    super(); 
    
    this.id = id;
    this.message = message;
    this.httpStatus = status || 500;
    this.data = data;
  }
}

/**
 * Identifier constants for API errors.
 */
const ErrorIds = {
  Forbidden: 'forbidden',
  InvalidRequestStructure: 'invalid-request-structure',
  UnknownResource: 'unknown-resource'
};
Object.freeze(ErrorIds);

/**
 * Helper "factory" methods for API errors.
 */
const factory = module.exports = {};

factory.invalidRequestStructure = (message) => {
  return new APIError(ErrorIds.InvalidRequestStructure, message, 400);
};

factory.forbidden = (message) => {
  return new APIError(ErrorIds.Forbidden, message, 403);
};

factory.unknownResource = (message) => {
  return new APIError(ErrorIds.UnknownResource, message, 404);
};