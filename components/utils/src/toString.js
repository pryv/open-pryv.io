// @flow

/**
 * Output usual objects as string, e.g. when logging.
 * TODO: make that a separate lib to use on client side too
 */

var toString = module.exports = {};

toString.id = function (id: string) {
  return '"' + id + '"';
};

toString.path = function (path: string) {
  return '"' + path + '"';
};

toString.property = function (propertyKey: string) {
  return '`' + propertyKey + '`';
};

type User = {
  username: string, 
  id?: string,
  _id?: string, 
}; 

toString.user = function (user: User) {
  return '"' + user.username + '" (' + (user.id || user._id || 'n/a') + ')';
};
