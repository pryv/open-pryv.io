/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
import type {} from 'node:fs';

/**
 * Regroups the different URL paths served by this module.
 */
const path = require('path');
const Params = {
  Username: 'username'
};
Object.freeze(Params);
const username = param(Params.Username);
const Paths = (module.exports = {
  // expose params for URL parsing
  Params,
  System: makePath('system'),
  Register: makePath('reg'),
  WWW: makePath('www'),
  UserRoot: makePath(username),
  Accesses: makePath(username, 'accesses'),
  Account: makePath(username, 'account'),
  Auth: makePath(username, 'auth'),
  Streams: makePath(username, 'streams'),
  Events: makePath(username, 'events'),
  Profile: makePath(username, 'profile'),
  Service: makePath(username, 'service'),
  Webhooks: makePath(username, 'webhooks'),
  Audit: makePath(username, 'audit/logs'),
  MFA: makePath(username, 'mfa'),
  SocketIO: makePath('socket.io'),
  SocketIO2: makePath('socket.io2'),
  Favicon: makePath('favicon.ico')
});
Object.freeze(Paths);
/**
 * @param {Array<string>} a
 * @returns {string}
 */
function makePath (...a) {
  a.unshift('/');
  return path.join(...a);
}
/**
 * @returns {string}
 */
function param (name) {
  return ':' + name;
}
