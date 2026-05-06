/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
/**
 * Regroups the different URL paths served by this module.
 */
const path = require('path');
const Params = {
  Username: 'username'
};
Object.freeze(Params);
const username = param(Params.Username);

const System = makePath('system');
const Register = makePath('reg');
const WWW = makePath('www');
const UserRoot = makePath(username);
const Accesses = makePath(username, 'accesses');
const Account = makePath(username, 'account');
const Auth = makePath(username, 'auth');
const Streams = makePath(username, 'streams');
const Events = makePath(username, 'events');
const Profile = makePath(username, 'profile');
const Service = makePath(username, 'service');
const Webhooks = makePath(username, 'webhooks');
const Audit = makePath(username, 'audit/logs');
const MFA = makePath(username, 'mfa');
const SocketIO = makePath('socket.io');
const SocketIO2 = makePath('socket.io2');
const Favicon = makePath('favicon.ico');

export {
  Params,
  System,
  Register,
  WWW,
  UserRoot,
  Accesses,
  Account,
  Auth,
  Streams,
  Events,
  Profile,
  Service,
  Webhooks,
  Audit,
  MFA,
  SocketIO,
  SocketIO2,
  Favicon
};

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
