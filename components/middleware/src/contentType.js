/**
 * Just validates that the request is of one of the specified content types; otherwise returns a
 * 415 error.
 */

var errors = require('components/errors').factory;

/**
 * Accepts a variable number of content types as arguments.
 */
function checkContentType(/* arguments */) {
  var acceptedTypes = arguments,
      count = acceptedTypes.length;
  return function (req, res, next) {
    if (count < 1) { return next(); }

    var contentType = req.headers['content-type'];
    if (! contentType) { return next(errors.missingHeader('Content-Type')); }

    for (var i = 0; i < count; i++) {
      if (req.is(acceptedTypes[i])) {
        return next();
      }
    }

    next(errors.unsupportedContentType(contentType));
  };
}

exports.json = checkContentType('application/json');
exports.jsonOrForm = checkContentType('application/json', 'application/x-www-form-urlencoded');
exports.multipartOrJson = checkContentType('multipart/form-data', 'application/json');
