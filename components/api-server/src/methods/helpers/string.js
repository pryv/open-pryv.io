/**
 * Helper for handling query string parameter values.
 */

var string = module.exports;

string.isReservedId = function (s) {
  switch (s) {
  case 'null':
  case 'undefined':
  case '*':
    return true;
  default:
    return false;
  }
};

string.toMongoKey = function (s) {
  return (s[0] === '$' ? '_' + s.substr(1) : s).replace('.', ':');
};
