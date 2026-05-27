/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/**
 * Output usual objects as string, e.g. when logging.
 */
const toString: any = {};
export { toString };
toString.id = function (id: any) {
  return '"' + id + '"';
};
toString.path = function (path: any) {
  return '"' + path + '"';
};
toString.property = function (propertyKey: any) {
  return '`' + propertyKey + '`';
};
toString.user = function (user: any) {
  return '"' + user.username + '" (' + (user.id || user._id || 'n/a') + ')';
};

type User = {
  username: string;
  id?: string;
  _id?: string;
};
