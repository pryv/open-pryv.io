/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const errors = require('errors').factory;
const validation = require('../../schema/validation.ts');
const { findForbiddenChar, isStreamIdValidForCreation } = require('../../schema/streamId.ts');
const { getLogger } = require('@pryv/boiler');
const logger = getLogger('commonFunctions');

type MethodContext = {
  access: { isPersonal (): boolean; can (methodId: string): boolean | string };
  methodId: string;
  [k: string]: unknown;
};
type ResultBag = Record<string, unknown>;
type Next = (err?: unknown) => void;
type AuthSettings = { trustedApps: string; [k: string]: unknown };
type TrustedApp = { appId: string; originRegExp: RegExp };
type SchemaError = { path: string; params?: unknown[]; code?: string; message?: string; schemaId?: unknown; param?: string; [k: string]: unknown };
type ParamsSchema = {
  messages?: Record<string, Record<string, { message?: string; code?: string }>>;
  alterableProperties?: string[];
  [k: string]: unknown;
};
type WarnLogger = { warn (msg: string): void };

export const requirePersonalAccess = function requirePersonalAccess (context: MethodContext, _params: unknown, _result: ResultBag, next: Next) {
  if (!context.access.isPersonal()) {
    return next(errors.forbidden('You cannot access this resource using the given access ' + 'token.'));
  }
  next();
};
/**
 * Basic check for authorized access based on context.methodId
 */
export const basicAccessAuthorizationCheck = function (context: MethodContext, _params: unknown, _result: ResultBag, next: Next) {
  const res = context.access.can(context.methodId);
  if (res === true) { return next(); }
  const message = typeof res === 'boolean'
    ? 'You cannot access ' +
            context.methodId +
            ' resource using the given access'
    : '' + res;
  return next(errors.forbidden(message));
};
/**
 * Returns a check whether the given app ID / origin pair match a trusted app defined in settings.
 * (Lazy-loads and caches the `trustedApps` setting.)
 * The returned function expects the call's `params` to have `appId` and `origin` properties.
 *
 */
export const getTrustedAppCheck = function getTrustedAppCheck (getAuthSettings: () => AuthSettings) {
  // `getAuthSettings` is a 0-arg function returning the current `auth`
  // config slice. The lazy-getter shape (vs a captured `const x =
  // config.get('auth')`) means config.set() / injectTestConfig() /
  // future async config sources reach this helper through the closure.
  // The trustedApps list is parsed on every request from the freshly-
  // resolved slice — negligible cost (a single split on a short
  // comma-separated list) and strictly more correct than a module-scope
  // memoization that would freeze the list at first request and make
  // tests' config injection invisible.
  return function requireTrustedApp (_context: MethodContext, params: { appId?: string; origin?: string }, _result: ResultBag, next: Next) {
    if (!isTrustedApp(params.appId, params.origin)) {
      return next(errors.invalidCredentials('The app id ("appId") is either missing or ' + 'not trusted.'));
    }
    next();
  };
  function isTrustedApp (appId: string | undefined, origin: string | undefined): boolean {
    const trustedApps: TrustedApp[] = [];
    getAuthSettings().trustedApps.split(',').forEach(function (pair: string) {
      const parts = /^\s*(\S+)\s*@\s*(\S+)\s*$/.exec(pair);
      if (parts == null || !Array.isArray(parts) || parts.length !== 3) {
        logger.error('Invalid Trusted app settings, please check: ' + pair);
        return;
      }
      trustedApps.push({
        appId: parts[1],
        originRegExp: getRegExp(parts[2])
      });
    });
    if (!appId) {
      return false;
    }
    let trustedApp;
    for (let i = 0, n = trustedApps.length; i < n; i++) {
      trustedApp = trustedApps[i];
      // accept wildcards for app ids (for use in tests/dev/staging only)
      if (trustedApp.appId !== appId && trustedApp.appId !== '*') {
        continue;
      }
      if (trustedApp.originRegExp.test(origin || '')) {
        return true;
      }
    }
    return false;
  }
  function getRegExp (origin: string): RegExp {
    // BUG The blacklist approach taken here is probably wrong; we're assuming
    //  that we can escape all the active parts of a string using a list of
    //  special chars; we're almost sure to miss something while doing that. A
    //  better approach would be to whitelist all characters that are allowed
    //  in the input language.
    // first escape the origin string
    let rxString = origin.replace(/([.*+?^=!:${}()|[\]\/\\])/g, '\\$1'); // eslint-disable-line no-useless-escape
    // then replace wildcards
    rxString = rxString.replace(/\\\*/g, '\\S*');
    return new RegExp('^' + rxString + '$');
  }
};
/** Produces a middleware function to verify parameters against the schema
 * given in `paramsSchema`.
 *
 * @param  {Object} paramsSchema JSON Schema for the parameters
 */
export const getParamsValidation = function getParamsValidation (paramsSchema: ParamsSchema) {
  return function validateParams (_context: MethodContext, params: unknown, _result: ResultBag, next: Next) {
    validation.validate(params, paramsSchema, function (err: SchemaError[] | null) {
      if (err) {
        const errorsList = err.map((error: SchemaError) => _addCustomMessage(error, paramsSchema));
        return next(errors.invalidParametersFormat("The parameters' format is invalid.", errorsList));
      }
      next();
    });
  };
};
export const isValidStreamIdForQuery = function isValidStreamIdForQuery (streamId: string, parameter: unknown, parameterName: string) {
  const forbiddenChar = findForbiddenChar(streamId);
  if (forbiddenChar != null) { throw new Error(`Error in '${parameterName}' parameter: ${JSON.stringify(parameter)}, forbidden character(s) in streamId '${streamId}'.`); }
};
export const isValidStreamIdForCreation = function isValidStreamIdForCreation (streamId: string) {
  return isStreamIdValidForCreation(streamId);
};
/**
 * Replaces z-schema message and code with a custom message given in the schema
 * !!! Important - it also removes error params and schemaId and
 * adds "param" that is equal to failing param id
 *
 * Before this function validation errors could look like this:
 * "error": {
        "id": "invalid-parameters-format",
        "message": "The parameters' format is invalid.",
        "data": [
            {
                "code": "PATTERN",
                "params": [
                    "^[a-z0-9][a-z0-9\\-]{3,58}[a-z0-9]$",
                    "ga"
                ],
                "message": "String does not match pattern ^[a-z0-9][a-z0-9\\-]{3,58}[a-z0-9]$: ga",
                "path": "#/username"
            }
        ]
    },

    And if custom error messages are provided, it could be changed to something like this:
 *
 * "error": {
        "id": "invalid-parameters-format",
        "message": "The parameters' format is invalid.",
        "data": [
            {
                "code": "username-invalid",
                "message": "Username should have from 5 to 60 characters and contain letters or numbers or dashes",
                "path": "#/username",
                "param": "username"
            }
        ]
    },
 *
 * @param object error
 * @param object schema
 */
function _addCustomMessage (error: SchemaError, schema: ParamsSchema): SchemaError {
  const pathElements = error.path.split('/');
  let paramId = pathElements[pathElements.length - 1];
  // when field is missing paramId will be empty
  if (paramId === '' && (error.params?.length ?? 0) >= 1) {
    paramId = String(error.params![0]);
  }
  // if there are custom messages set, replace default z-schema message
  if (schema?.messages?.[paramId] != null) {
    // if there is a message, set it
    if (schema.messages[paramId][error.code!]?.message) {
      error.message = schema.messages[paramId][error.code!].message;
    }
    // if there is a custom error code, set it
    if (schema.messages[paramId][error.code!]?.code) {
      error.code = schema.messages[paramId][error.code!].code;
    }
    // delete missleading error parameters
    if ('params' in error) {
      delete error.params;
    }
    // delete schemaId
    if ('schemaId' in error) {
      delete error.schemaId;
    }
    // make frontenders happier and instead of having 'path' with
    // modified param name, pass not modified param too
    error.param = paramId;
  }
  // if there are no custom messages, just return default z-schema message
  return error;
}
// `ignoreOrGetter` accepts either a literal (legacy callers like
// webhooks.ts that pass `false` because the setting is hard-coded) OR a
// 0-arg getter function (factories that bind to a live config key, so
// config.set() / injectTestConfig() reach this validator at request
// time instead of freezing the value at api-register time).
export const catchForbiddenUpdate = function catchForbiddenUpdate (paramsSchema: ParamsSchema, ignoreOrGetter: boolean | (() => boolean), logger: WarnLogger) {
  const getIgnore: () => boolean = typeof ignoreOrGetter === 'function' ? ignoreOrGetter : () => ignoreOrGetter;
  return function validateParams (_context: MethodContext, params: { update: Record<string, unknown> }, _result: ResultBag, next: Next) {
    const ignoreProtectedFieldUpdates = getIgnore();
    const allowed = paramsSchema.alterableProperties!;
    const forbidden = Object.keys(params.update).filter((key) => !allowed.includes(key));
    if (forbidden.length > 0) {
      const errorMsg = 'Forbidden update was attempted on the following protected field(s): [' +
                forbidden +
                '].';
      // Strict mode: throw a forbidden error
      if (!ignoreProtectedFieldUpdates) {
        return next(errors.forbidden(errorMsg));
      }
      // Non-strict mode:
      // Ignore protected fields in update
      forbidden.forEach((key) => {
        delete params.update[key];
      });
      // Log a warning
      logger.warn(errorMsg +
                '\n' +
                'Server has "ignoreProtectedFieldUpdates" turned on: Fields are not updated, but no error is thrown.');
    }
    next();
  };
};
