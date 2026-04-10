/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
/**
 * Output usual objects as string, e.g. when logging.
 * TODO: make that a separate lib to use on client side too
 */
const toString = (module.exports = {});
toString.id = function (id) {
  return '"' + id + '"';
};
toString.path = function (path) {
  return '"' + path + '"';
};
toString.property = function (propertyKey) {
  return '`' + propertyKey + '`';
};
toString.user = function (user) {
  return '"' + user.username + '" (' + (user.id || user._id || 'n/a') + ')';
};

/**
 * @typedef {{
 *   username: string;
 *   id?: string;
 *   _id?: string;
 * }} User
 */
