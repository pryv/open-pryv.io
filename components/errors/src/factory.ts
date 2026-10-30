/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

import { randomBytes } from 'node:crypto';
import type { APIError as APIErrorT } from './APIError.ts';
import { APIError } from './APIError.ts';
import { ErrorIds } from './ErrorIds.ts';
import { ErrorMessages } from './ErrorMessages.ts';

/**
 * The full factory contract — one entry per error producer below.
 * Keeping the interface next to the assignments means a signature change
 * in either place is a compile error.
 */
interface ErrorFactory {
  unsupportedOperation: (message: string) => APIErrorT;
  apiUnavailable: (message: string) => APIErrorT;
  corruptedData: (message: string, innerError?: Error) => APIErrorT;
  forbidden: (message?: string, data?: unknown) => APIErrorT;
  invalidAccessToken: (message: string, status?: number) => APIErrorT;
  invalidCredentials: (message?: string) => APIErrorT;
  invalidEventType: (type: string) => APIErrorT;
  invalidItemId: (message?: string) => APIErrorT;
  invalidMethod: (methodId: string) => APIErrorT;
  invalidOperation: (message: string, data?: unknown, innerError?: Error) => APIErrorT;
  invalidParametersFormat: (message: string, data?: unknown, innerError?: Error) => APIErrorT;
  invalidRequestStructure: (message: string, data?: unknown, innerError?: Error) => APIErrorT;
  itemAlreadyExists: (resourceType: string, conflictingKeys: Record<string, unknown>, innerError?: Error) => APIErrorT;
  staleResource: (resourceType: string, data?: Record<string, unknown>) => APIErrorT;
  missingHeader: (headerName: string, status?: number) => APIErrorT;
  tooManyResults: (limit: number) => APIErrorT;
  tooManyAttempts: (retryAfterSeconds?: number, options?: { message?: string; data?: unknown }) => APIErrorT;
  invalidStepUp: (message?: string) => APIErrorT;
  mfaMethodInactive: (method: string) => APIErrorT;
  payloadTooLarge: (message: string, data?: unknown) => APIErrorT;
  unexpectedError: (sourceError: unknown, message?: string) => APIErrorT;
  unknownReferencedResource: (resourceType: string, paramKey: string, value: string | string[], innerError?: Error) => APIErrorT;
  unknownResource: (resourceType?: string, id?: string, innerError?: Error) => APIErrorT;
  unsupportedContentType: (contentType: string) => APIErrorT;
  goneResource: () => APIErrorT;
  unavailableMethod: (message?: string) => APIErrorT;
  InvalidInvitationToken: () => APIErrorT;
  externalIdAlreadyClaimed: (namespace: string, reason: 'value-taken' | 'namespace-taken') => APIErrorT;
  externalIdNamespaceInUse: (namespace: string) => APIErrorT;
  autoDeletionDelegateRefused: () => APIErrorT;
  autoDeletionPasswordRequired: () => APIErrorT;
  autoDeletionWrongPassword: () => APIErrorT;
  autoDeletionOutOfBounds: (message: string, data: Record<string, unknown>) => APIErrorT;
  autoDeletionOptOutNotAllowed: () => APIErrorT;
  autoDeletionOverrideNotAllowed: (reason: 'user-override-disabled' | 'inactivity-unavailable') => APIErrorT;
  autoDeletionActionNotAllowed: (action: string, available: string[]) => APIErrorT;
  autoDeletionNoEmail: (reason: 'no-email' | 'mail-not-configured') => APIErrorT;
  autoDeletionTransferInvalidLink: () => APIErrorT;
  autoDeletionTransferExpired: () => APIErrorT;
  autoDeletionTransferClaimed: () => APIErrorT;
  autoDeletionTransferLocked: (retryAfterSeconds: number) => APIErrorT;
  autoDeletionTransferInvalid: (message: string, data: Record<string, unknown>) => APIErrorT;
}

/**
 * Helper "factory" methods for API errors (see error ids).
 * Populated by the assignments below — the cast is resolved by the time
 * the module finishes evaluating.
 */
const factory: ErrorFactory = {} as ErrorFactory;
export { factory };
export type { ErrorFactory };

factory.unsupportedOperation = (message: string) => {
  return new APIError(ErrorIds.ApiUnavailable, message, {
    httpStatus: 501
  });
};

factory.apiUnavailable = (message: string) => {
  return new APIError(ErrorIds.ApiUnavailable, message, {
    httpStatus: 503
  });
};

factory.corruptedData = function (message: string, innerError?: Error) {
  return new APIError(ErrorIds.CorruptedData, message, {
    httpStatus: 422,
    innerError
  });
};

factory.forbidden = function (message?: string, data?: unknown) {
  if (message == null) {
    message =
            "The given token's access permissions do not allow this operation.";
  }
  return new APIError(ErrorIds.Forbidden, message, {
    httpStatus: 403,
    data
  });
};

factory.invalidAccessToken = function (message: string, status?: number) {
  return new APIError(ErrorIds.InvalidAccessToken, message, {
    httpStatus: status || 401
  });
};

factory.invalidCredentials = function (message?: string) {
  return new APIError(ErrorIds.InvalidCredentials, message || 'The given username/password pair is invalid.', {
    httpStatus: 401
  });
};

factory.invalidEventType = function (type: string) {
  return new APIError(ErrorIds.InvalidEventType, "Event type '" +
        type +
        "' not allowed " +
        'for High-Frequency Series. Please use a predefined simple type', { data: { type }, httpStatus: 400 });
};

factory.invalidItemId = function (message?: string) {
  return new APIError(ErrorIds.InvalidItemId, message || '', {
    httpStatus: 400
  });
};

factory.invalidMethod = function (methodId: string) {
  return new APIError(ErrorIds.InvalidMethod, 'Invalid method id "' + methodId + '"', { httpStatus: 404 });
};

factory.invalidOperation = function (message: string, data?: unknown, innerError?: Error) {
  return new APIError(ErrorIds.InvalidOperation, message, {
    httpStatus: 400,
    data,
    innerError
  });
};

factory.invalidParametersFormat = function (message: string, data?: unknown, innerError?: Error) {
  return new APIError(ErrorIds.InvalidParametersFormat, message, {
    httpStatus: 400,
    data,
    innerError
  });
};

factory.invalidRequestStructure = function (message: string, data?: unknown, innerError?: Error) {
  return new APIError(ErrorIds.InvalidRequestStructure, message, {
    httpStatus: 400,
    data,
    innerError
  });
};

factory.itemAlreadyExists = function (resourceType: string, conflictingKeys: Record<string, unknown>, innerError?: Error) {
  resourceType = resourceType || 'resource';
  const keysDescription = Object.keys(conflictingKeys)
    .map(function (k) {
      return k + ' "' + conflictingKeys[k] + '"';
    })
    .join(', ');
  const message = functionGetRightArticle(resourceType) +
        resourceType +
        ' with ' +
        keysDescription +
        ' already exists';
  return new APIError(ErrorIds.ItemAlreadyExists, message, {
    httpStatus: 409,
    innerError: innerError || null,
    data: conflictingKeys
  });
};

factory.staleResource = function (resourceType: string, data?: Record<string, unknown>) {
  resourceType = resourceType || 'resource';
  const message = 'Stale ' + resourceType + ' reference — refetch and retry with the current head id.';
  return new APIError(ErrorIds.StaleResource, message, {
    httpStatus: 409,
    data: data || {}
  });
};

factory.missingHeader = function (headerName: string, status?: number) {
  return new APIError(ErrorIds.MissingHeader, 'Missing expected header "' + headerName + '"', {
    httpStatus: status || 400
  });
};

factory.tooManyResults = function (limit: number) {
  return new APIError(ErrorIds.TooManyResults, 'Your request gave too many results (the limit is ' +
        limit +
        '. Directly calling ' +
        'the API method (i.e. not batching calls), narrowing request scope or paging can help.', { data: { limit }, httpStatus: 413 });
};

/**
 * Account-level attempt limiter tripped. Carries no count and no ceiling so a
 * caller learns nothing about how close it got; `Retry-After` (seconds) is set
 * when the remaining lock time is known, so a legitimate client can back off.
 */
factory.tooManyAttempts = function (retryAfterSeconds?: number, options?: { message?: string; data?: unknown }) {
  // The MFA wording is the default for back-compatibility; other throttled
  // flows (the registration email challenge) pass their own.
  const err = new APIError(ErrorIds.TooManyAttempts,
    options?.message ?? 'Too many failed MFA attempts for this account. Please try again later.',
    { httpStatus: 429, data: options?.data });
  if (retryAfterSeconds != null && retryAfterSeconds > 0) {
    err.httpHeaders = { 'Retry-After': String(Math.ceil(retryAfterSeconds)) };
  }
  return err;
};

/**
 * The step-up given for a sensitive operation (account password, or a code of
 * the current second factor) does not match. One answer for both kinds, so a
 * caller cannot tell which of the two it got wrong.
 */
factory.invalidStepUp = function (message?: string) {
  return new APIError(ErrorIds.InvalidStepUp,
    message ?? 'The given password or MFA code does not match; the operation was not performed.',
    { httpStatus: 403 });
};

/**
 * The account's second factor uses a method that is not enabled on this
 * server: the login is refused rather than completed with the password only.
 */
factory.mfaMethodInactive = function (method: string) {
  return new APIError(ErrorIds.MfaMethodInactive,
    `This account's second factor (${method}) is not enabled on this server; contact the platform operator.`,
    { httpStatus: 403 });
};

factory.payloadTooLarge = function (message: string, data?: unknown) {
  return new APIError(ErrorIds.PayloadTooLarge, message, {
    httpStatus: 413,
    data
  });
};

factory.unexpectedError = function (sourceError: unknown, message?: string) {
  // If a message was given: display it.
  if (message != null) { return produceError(message); }
  // Sometimes people throw strings
  if (typeof sourceError === 'string') { return produceError(sourceError); }
  // An Error: its message (file paths, driver or database text) is not for the
  // client, nor for the audit trail the user can read. The public text carries
  // a short reference instead; the source error stays as `innerError`, which
  // `errorHandling.logError` writes (stack included) on the same log line as
  // that reference.
  const error = sourceError;
  if (error != null && error instanceof Error) {
    const ref = randomBytes(4).toString('hex');
    return new APIError(ErrorIds.UnexpectedError, `${ErrorMessages[ErrorIds.UnexpectedError]} (ref ${ref})`,
      { httpStatus: 500, innerError: error });
  }
  // Give up:
  return produceError('(no message given)');
  function produceError (msg: string) {
    const text = `${ErrorMessages[ErrorIds.UnexpectedError]}: ${msg}`;
    return new APIError(ErrorIds.UnexpectedError, text, { httpStatus: 500 });
  }
};

factory.unknownReferencedResource = function (resourceType: string, paramKey: string, value: string | string[], innerError?: Error) {
  const joinedVals = typeof value === 'string' ? value : value.join('", "');
  const resourceTypeText = resourceType || 'resource(s)';
  const message = `Unknown referenced ${resourceTypeText} "${joinedVals}"`;
  const data: Record<string, unknown> = {};
  data[paramKey] = value;
  return new APIError(ErrorIds.UnknownReferencedResource, message, {
    httpStatus: 400,
    data,
    innerError
  });
};

factory.unknownResource = function (resourceType?: string, id?: string, innerError?: Error) {
  const message = 'Unknown ' +
        (resourceType || 'resource') +
        (id ? ' "' + id + '"' : '');
  return new APIError(ErrorIds.UnknownResource, message, {
    httpStatus: 404,
    innerError
  });
};

factory.unsupportedContentType = function (contentType: string) {
  return new APIError(ErrorIds.UnsupportedContentType, `If you think we should, please help us and report an issue! (You used ${contentType})`, { httpStatus: 415 });
};

factory.goneResource = function () {
  return new APIError(ErrorIds.Gone, 'API method gone, please stop using it.', {
    httpStatus: 410
  });
};

factory.unavailableMethod = function (message?: string) {
  // The caller's message reaches the wire: a method can be unavailable for
  // reasons that have nothing to do with licensing (an operator turning an
  // optional feature off, say), and answering with the licence text sends the
  // reader chasing the wrong thing.
  return new APIError(ErrorIds.unavailableMethod, message ??
    'API method unavailable in current version. This method is only available in the commercial license.', {
    httpStatus: 451
  });
};

/**
 * Check in service-register if email is used
 * The name is used in the service-core and service-register
 **/
factory.InvalidInvitationToken = () => {
  const opts = {
    httpStatus: 400,
    data: { param: 'invitationToken' }
  };
  return new APIError(ErrorIds.InvalidInvitationToken, ErrorMessages[ErrorIds.InvalidInvitationToken], opts);
};

/**
 * The message and data name the namespace only: neither the value, nor the
 * account or the core holding it.
 */
factory.externalIdAlreadyClaimed = function (namespace: string, reason: 'value-taken' | 'namespace-taken') {
  const message = reason === 'namespace-taken'
    ? `This account already holds an id in namespace "${namespace}"; use replace to change it.`
    : `This id of namespace "${namespace}" is already linked to another account.`;
  return new APIError(ErrorIds.ExternalIdAlreadyClaimed, message, {
    httpStatus: 409,
    data: { namespace, reason }
  });
};

factory.externalIdNamespaceInUse = function (namespace: string) {
  return new APIError(ErrorIds.ExternalIdNamespaceInUse,
    `Namespace "${namespace}" still has linked ids; delete it with force=true to remove the namespace anyway.`, {
      httpStatus: 409,
      data: { namespace }
    });
};

factory.autoDeletionDelegateRefused = function () {
  return new APIError(ErrorIds.AutoDeletionDelegateRefused,
    'The auto-deletion of an account can only be set with its own login; a delegated session cannot set it.',
    { httpStatus: 403 });
};

factory.autoDeletionPasswordRequired = function () {
  return new APIError(ErrorIds.AutoDeletionPasswordRequired,
    'This change schedules the deletion of the account or brings it nearer: send the account password in "password".',
    { httpStatus: 403 });
};

factory.autoDeletionWrongPassword = function () {
  return new APIError(ErrorIds.AutoDeletionWrongPassword,
    'The given password does not match; the auto-deletion setting was not changed.',
    { httpStatus: 403 });
};

factory.autoDeletionOutOfBounds = function (message: string, data: Record<string, unknown>) {
  return new APIError(ErrorIds.AutoDeletionOutOfBounds, message, { httpStatus: 400, data });
};

factory.autoDeletionOptOutNotAllowed = function () {
  return new APIError(ErrorIds.AutoDeletionOptOutNotAllowed,
    'This platform deletes accounts unused for a while and does not allow opting out.',
    { httpStatus: 403 });
};

factory.autoDeletionOverrideNotAllowed = function (reason: 'user-override-disabled' | 'inactivity-unavailable') {
  const message = reason === 'inactivity-unavailable'
    ? 'This platform does not record account use, so a deletion after a period without use cannot be set.'
    : 'This platform does not allow choosing when an account is deleted.';
  return new APIError(ErrorIds.AutoDeletionOverrideNotAllowed, message, { httpStatus: 403, data: { reason } });
};

factory.autoDeletionActionNotAllowed = function (action: string, available: string[]) {
  return new APIError(ErrorIds.AutoDeletionActionNotAllowed,
    `The auto-deletion action "${action}" is not available on this platform.`,
    { httpStatus: 403, data: { action, available } });
};

factory.autoDeletionNoEmail = function (reason: 'no-email' | 'mail-not-configured') {
  const why = reason === 'no-email' ? 'the account has no email address' : 'this platform cannot send mail';
  return new APIError(ErrorIds.AutoDeletionNoEmail,
    `No reminder can be sent before the deletion (${why}): send "acknowledgeNoReminders": true to set it anyway.`,
    { httpStatus: 400, data: { reason } });
};

factory.autoDeletionTransferInvalidLink = function () {
  return new APIError(ErrorIds.AutoDeletionTransferInvalidLink,
    'This link is not valid: it may have been replaced by a newer one, or the transfer was cancelled.',
    { httpStatus: 403 });
};

factory.autoDeletionTransferExpired = function () {
  return new APIError(ErrorIds.AutoDeletionTransferExpired,
    'The period to claim this account has ended.',
    { httpStatus: 410 });
};

factory.autoDeletionTransferClaimed = function () {
  return new APIError(ErrorIds.AutoDeletionTransferClaimed,
    'This account was already claimed by another account.',
    { httpStatus: 409 });
};

factory.autoDeletionTransferLocked = function (retryAfterSeconds: number) {
  return new APIError(ErrorIds.AutoDeletionTransferLocked,
    'Too many failed attempts to claim this account: claims are refused for now.',
    { httpStatus: 429, data: { retryAfterSeconds } });
};

factory.autoDeletionTransferInvalid = function (message: string, data: Record<string, unknown>) {
  return new APIError(ErrorIds.AutoDeletionTransferInvalid, message, { httpStatus: 400, data });
};

/**
 * Get the right article for the noun
 */
function functionGetRightArticle (noun: string): string {
  return ['a', 'e', 'i', 'o', 'u'].includes(noun[0].toLowerCase())
    ? 'An '
    : 'A ';
}
