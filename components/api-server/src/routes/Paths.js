// @flow

/**
 * Regroups the different URL paths served by this module.
 */

const path = require('path');

const Params = {
  Username: 'username'
};
Object.freeze(Params);


const username = param(Params.Username);
const Paths = module.exports = {
  // expose params for URL parsing
  Params: Params,

  System: makePath('system'),
  Register: makePath('reg'),
  WWW: makePath('www'),
  UserRoot: makePath(username),

  Accesses: makePath(username, 'accesses'),
  Account: makePath(username, 'account'),
  Auth: makePath(username, 'auth'),
  FollowedSlices: makePath(username, 'followed-slices'),
  Streams: makePath(username, 'streams'),
  Events: makePath(username, 'events'),
  Profile: makePath(username, 'profile'),
  Service: makePath(username, 'service'),
  Webhooks: makePath(username, 'webhooks'),

  SocketIO: makePath('socket.io'),
  SocketIO2: makePath('socket.io2'),
  Favicon: makePath('favicon.ico')
};
Object.freeze(Paths);

function makePath(...a: Array<string>): string {
  a.unshift('/');

  return path.join(...a);
}

function param(name) {
  return ':' + name;
}
