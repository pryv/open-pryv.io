/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
import type {} from 'node:fs';

const ALL_METHODS = [
  'getAccessInfo',
  'callBatch',
  'auth.login',
  'auth.logout',
  'auth.register',
  'auth.usernameCheck',
  'auth.emailCheck',
  'auth.cores',
  'auth.delete',
  'mfa.activate',
  'mfa.confirm',
  'mfa.challenge',
  'mfa.verify',
  'mfa.deactivate',
  'mfa.recover',
  'accesses.get',
  'accesses.getOne',
  'accesses.create',
  'accesses.update',
  'accesses.delete',
  'accesses.checkApp',
  'service.info',
  'webhooks.get',
  'webhooks.getOne',
  'webhooks.create',
  'webhooks.update',
  'webhooks.delete',
  'webhooks.test',
  'account.get',
  'account.update',
  'account.changePassword',
  'account.changeUsername',
  'account.usernameChanges',
  'account.requestPasswordReset',
  'account.resetPassword',
  'profile.getPublic',
  'profile.getApp',
  'profile.get',
  'profile.updateApp',
  'profile.update',
  'streams.get',
  'streams.create',
  'streams.update',
  'streams.delete',
  'events.get',
  'events.getOne',
  'events.create',
  'events.update',
  'events.delete',
  'events.getAttachment',
  'events.deleteAttachment',
  'system.checkPlatformIntegrity',
  'system.createUser',
  'system.deactivateMfa',
  'system.getUserInfo',
  'system.listUsers',
  'system.listCores',
  'auth.hostings',
  // OAuth 2.0 authorization-server events. Emitted directly via
  // audit.eventForUser() from the oauth2 component's grant/consent paths
  // (they are NOT api.register API methods, so they never pass through
  // throwIfMethodIsNotDeclared — but they must be declared here so the
  // AuditFilter recognises them, otherwise isAudited() returns undefined).
  'oauth.consent.shown',
  'oauth.consent.granted',
  'oauth.consent.refused',
  'oauth.code.exchanged',
  'oauth.code.reused',
  'oauth.token.issued.authorization_code',
  'oauth.token.issued.client_credentials',
  'oauth.token.refreshed',
  'oauth.token.revoked'
];

const NOT_AUDITED_METHODS = [
  'service.info',
  'system.getUserInfo',
  'auth.usernameCheck',
  'auth.emailCheck',
  'auth.cores',
  'auth.hostings',
  'system.checkPlatformIntegrity',
  'system.listCores'
];

const AUDITED_METHODS = ALL_METHODS.filter(m => !NOT_AUDITED_METHODS.includes(m));

// doesnt include non-audited ones
const WITHOUT_USER_METHODS = [
  'auth.register',
  'auth.delete',
  'system.createUser',
  'system.deactivateMfa',
  'mfa.recover'
];

const WITH_USER_METHODS = AUDITED_METHODS.filter(m => !WITHOUT_USER_METHODS.includes(m));

const allMethodsMap = buildMap(ALL_METHODS);

type MethodsMap = Record<string, true>;

function throwIfMethodIsNotDeclared (methodId: string): void {
  if (methodId.includes('*')) return; // including to register for wildcards such as "*"
  if (allMethodsMap[methodId]) return;
  throw new Error('Attempting to add a method not declared in audit, methodId: "' + methodId + '". Please add it to components/audit/src/ApiMethods.js#ALL_METHODS');
}

const AUDITED_METHODS_MAP = buildMap(AUDITED_METHODS);
const ALL_METHODS_MAP = allMethodsMap;
const WITHOUT_USER_METHODS_MAP = buildMap(WITHOUT_USER_METHODS);
export { AUDITED_METHODS, AUDITED_METHODS_MAP, ALL_METHODS, ALL_METHODS_MAP, WITHOUT_USER_METHODS, WITHOUT_USER_METHODS_MAP, WITH_USER_METHODS, throwIfMethodIsNotDeclared };

/**
 * Builds a map with an { i => true } entry for each array element
 */
function buildMap (array: string[]): MethodsMap {
  const map: MethodsMap = {};
  array.forEach((i: string) => {
    map[i] = true;
  });
  return map;
}
