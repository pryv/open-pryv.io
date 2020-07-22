const errors = require('components/errors').factory;

/**
 * '404' handling to override Express' defaults. Must be set after the routes in the init sequence.
 */
module.exports = function (req, res, next) {
  return next(errors.unknownResource());
};
