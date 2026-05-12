/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
import type {} from 'node:fs';

function setAuditAccessId (accessId: any) {
  return function (context: any, params: any, result: any, next: any) {
    if (!context.access) context.access = {};
    if (context.access.id != null) {
      return next(new Error('Access Id was already set to ' + context.access.id + ' when trying to set it to ' + accessId));
    }
    context.access.id = accessId;
    next();
  };
}

const AuditAccessIds = {
  VALID_PASSWORD: 'valid-password',
  PASSWORD_RESET_REQUEST: 'password-reset-request',
  PASSWORD_RESET_TOKEN: 'password-reset-token',
  ADMIN_TOKEN: 'admin',
  PUBLIC: 'public',
  INVALID: 'invalid'
};

Object.freeze(AuditAccessIds);

export { setAuditAccessId, AuditAccessIds };
