/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

type User = {
  username: string;
  id?: string;
  _id?: string;
};

type ToString = {
  id: (id: string) => string;
  path: (path: string) => string;
  property: (propertyKey: string) => string;
  user: (user: User) => string;
};

/**
 * Output usual objects as string, e.g. when logging.
 */
const toString: ToString = {
  id (id: string): string {
    return '"' + id + '"';
  },
  path (path: string): string {
    return '"' + path + '"';
  },
  property (propertyKey: string): string {
    return '`' + propertyKey + '`';
  },
  user (user: User): string {
    return '"' + user.username + '" (' + (user.id || user._id || 'n/a') + ')';
  }
};
export { toString };
