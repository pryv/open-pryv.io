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
  'auth.ssoLogin',
  'auth.logout',
  'auth.register',
  'auth.usernameCheck',
  'auth.emailCheck',
  'auth.emailChallenge',
  'auth.emailChallengeVerify',
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
  'sharedSecrets.create',
  'sharedSecrets.retrieve',
  'sharedSecrets.getOne',
  'webhooks.update',
  'webhooks.delete',
  'webhooks.test',
  'webhooks.rotateSecret',
  'account.get',
  'account.update',
  'account.changePassword',
  'account.changeUsername',
  'account.usernameChanges',
  'account.requestPasswordReset',
  'account.resetPassword',
  'account.verifyEmail',
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
  // Account-delegation method family. Client-facing handshake + lists plus the
  // core-to-core controlled-side responses. Declared so the audit filter and
  // the method-registration gate recognise them.
  'delegations.requestAttach',
  'delegations.acceptAttach',
  'delegations.refuseAttach',
  'delegations.cancelInvite',
  'delegations.detachDelegate',
  'delegations.dismissControlled',
  'delegations.createAccount',
  'delegations.listDelegates',
  'delegations.listControlled',
  'delegations.getToken',
  'delegations.acceptResponse',
  'delegations.refuseResponse',
  'delegations.acceptComplete',
  'delegations.issueToken',
  'delegations.notifyDetach',
  'delegations.releaseControl',
  'delegations.controlledStatus',
  'system.checkPlatformIntegrity',
  'system.createUser',
  'system.deactivateMfa',
  'system.getUserInfo',
  'system.getAccess',
  'system.listUsers',
  'system.listCores',
  'system.getEventTypesStatus',
  'system.getMigrationsStatus',
  'system.getAuditStatus',
  'system.extIdNamespaces.list',
  'system.extIdNamespaces.get',
  'system.extIdNamespaces.set',
  'system.extIdNamespaces.delete',
  'system.extIdHolds',
  'system.extIdRelease',
  // An administrator restarts or removes an account's auto-deletion schedule.
  'system.autoDeletion.reset',
  // The erasure ledger (admin key): no account of this core in the context.
  'system.erasures.list',
  'system.erasures.get',
  // The effective configuration of the core (admin key), secrets redacted.
  'system.getEffectiveConfig',
  // Platform setup, administrator sessions, roles and claim codes (the admin
  // key, a setup or admin session, or a personal token): no account of this
  // core in the call's context.
  'system.setup.getStatus',
  'system.setup.getChecks',
  'system.setup.createSession',
  'system.setup.createFirstAdmin',
  'system.setup.setReady',
  'system.setup.replaceCode',
  'system.adminSession.create',
  'system.adminSession.get',
  'system.adminSession.delete',
  'system.adminSession.updateExpiry',
  'system.adminSession.verifyStepUp',
  'system.claimCodes.create',
  'system.roles.claim',
  'system.roles.list',
  'system.roles.delete',
  'system.portalContext.get',
  // Those acts recorded in the acting administrator's own trail (emitted
  // directly via audit.eventForUser() when the account is on the core).
  'admin.role.created',
  'admin.role.claimed',
  'admin.role.deleted',
  'admin.claimCode.created',
  'admin.setupCode.replaced',
  'admin.session.created',
  'admin.session.deleted',
  'admin.session.updatedSecondFactor',
  'auth.hostings',
  // External ids of the account (personal token), and the core lookup by id.
  'account.externalIds.claim',
  'account.externalIds.list',
  'account.externalIds.release',
  'account.externalIds.replace',
  'auth.extIdCores',
  // Account auto-deletion setting (personal token).
  'account.getAutoDeletion',
  'account.setAutoDeletion',
  'account.addressAliases.create',
  'account.addressAliases.list',
  'account.addressAliases.delete',
  // Activity counts of the account's audit trail (personal token).
  'audit.getSummary',
  // Account transfer to a beneficiary: public, the mailed link is the
  // credential (recorded in the owner's trail).
  'account.transferClaim',
  'account.transferDecline',
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
  'oauth.nonce.reused',
  'oauth.token.issued.authorization_code',
  'oauth.token.issued.client_credentials',
  'oauth.token.refreshed',
  'oauth.token.reuse_detected',
  'oauth.token.dpop_mismatch',
  'oauth.token.revoked',
  'oauth.token.introspected',
  'oauth.token.exchanged',
  'oauth.token.exchange_refused',
  'oauth.client.metadata_fetched',
  'oauth.client.metadata_refused',
  // Third-party sign-in (OIDC relying party). Emitted from routes/sso.ts's
  // onIdentity (a bare api.call bypasses the method-wrapper audit, like oauth2).
  // sso.login is user-resolved (the signed-in account's trail); sso.failed too:
  // the account was found, its session or hand-off could not be made;
  // sso.refused has no resolvable user at emit time (no account, unproved email).
  'sso.login',
  'sso.failed',
  'sso.refused',
  // MFA removed from outside the account's own session (a recovery code, an
  // admin reset). Emitted directly via audit.eventForUser() from the mfa and
  // system methods, whose own calls are audited without a user, so that the
  // account's trail records the change.
  'mfa.recovered',
  'mfa.deactivatedByAdmin',
  // An external id released by an administrator (system.extIdRelease, audited
  // without a user): recorded in the trail of the account that held it.
  'account.externalIds.adminRelease',
  // An account erased by the auto-deletion sweep (no API call): recorded in
  // its own trail before the erasure, where the trail outlives the account
  // (`audit.onUserDelete: keep`).
  'account.autoDeletion.erase',
  // An auto-deletion schedule reset by an administrator
  // (system.autoDeletion.reset, audited without a user): recorded in the
  // account's own trail.
  'account.autoDeletion.resetByAdmin',
  // App and shared accesses the server itself creates, changes (permissions,
  // expiry) or deletes, without an `accesses.*` call: recorded in the trail of
  // the account that holds them (api-server methods/helpers/accessWriteAudit.ts).
  'accesses.created',
  'accesses.changed',
  'accesses.deleted',
  // An account created on this core (by auth.register, system.createUser or
  // delegations.createAccount): recorded by the server in the new account's
  // own trail, once it exists (api-server
  // methods/helpers/accountCreationAudit.ts).
  'account.created',
  // An account erased, by any path (auth.delete, the auto-deletion sweep,
  // bin/erasures.js --replay, a creation rolled back): recorded by the server
  // in the account's own trail before its data goes, only where the trail
  // outlives the account (`audit.onUserDelete: keep`; business
  // src/auth/accountAudit.ts, the erasure step recordAccountDeleted).
  'account.deleted',
  // An account restored from a backup (bin/backup.js --restore): recorded in
  // the restored account's trail once the restore keeps it (business
  // src/auth/accountAudit.ts, RestoreOrchestrator.recordRestored).
  'account.restored'
];

const NOT_AUDITED_METHODS = [
  'service.info',
  'system.getUserInfo',
  // getAccess is a pure PlatformDB read carrying no user method-context; it
  // must not reach per-user audit storage.forUser(undefined).
  'system.getAccess',
  'auth.usernameCheck',
  'auth.emailCheck',
  'auth.cores',
  'auth.hostings',
  'system.checkPlatformIntegrity',
  'system.listCores',
  // read-only dictionary status introspection, no per-user context
  'system.getEventTypesStatus',
  // read-only storage schema status, no per-user context
  'system.getMigrationsStatus',
  // read-only count of lost audit records, no per-user context
  'system.getAuditStatus',
  // read-only, no per-user context
  'system.extIdNamespaces.list',
  'system.extIdNamespaces.get',
  // the holder answer of the forced accept check: a read, one per probe
  'system.extIdHolds',
  // the unauthenticated lookup, like auth.cores
  'auth.extIdCores',
  // reads of the setup state, an administrator's own session, the role rows
  // and the portal context, the setup checks summary
  'system.setup.getStatus',
  'system.setup.getChecks',
  'system.adminSession.get',
  'system.roles.list',
  'system.portalContext.get'
];

const AUDITED_METHODS = ALL_METHODS.filter(m => !NOT_AUDITED_METHODS.includes(m));

// doesnt include non-audited ones
const WITHOUT_USER_METHODS = [
  'auth.register',
  'auth.emailChallenge',
  'auth.emailChallengeVerify',
  'auth.delete',
  'system.createUser',
  'system.deactivateMfa',
  'system.extIdNamespaces.set',
  'system.extIdNamespaces.delete',
  'system.extIdRelease',
  'system.autoDeletion.reset',
  'system.erasures.list',
  'system.erasures.get',
  'system.getEffectiveConfig',
  'system.setup.createSession',
  'system.setup.createFirstAdmin',
  'system.setup.setReady',
  'system.setup.replaceCode',
  'system.adminSession.create',
  'system.adminSession.delete',
  'system.adminSession.updateExpiry',
  'system.adminSession.verifyStepUp',
  'system.claimCodes.create',
  'system.roles.claim',
  'system.roles.delete',
  'mfa.recover',
  // OAuth events with no resolvable user at emit time (pre-consent /authorize,
  // /refuse, or reuse of an already-consumed code/refresh where the user is
  // unknown). These route to syslog only — never per-user storage — so they
  // must NOT reach storage.forUser(undefined). Keep in lock-step with
  // components/oauth2/src/audit.ts#USERLESS_EVENTS.
  'oauth.consent.shown',
  'oauth.consent.refused',
  'oauth.code.reused',
  'oauth.token.introspected',
  'oauth.token.exchange_refused',
  'oauth.client.metadata_fetched',
  'oauth.client.metadata_refused',
  // SSO refusals resolve no user (no-account / unproved email).
  'sso.refused'
];

const WITH_USER_METHODS = AUDITED_METHODS.filter(m => !WITHOUT_USER_METHODS.includes(m));

const allMethodsMap = buildMap(ALL_METHODS);

type MethodsMap = Record<string, true>;

function throwIfMethodIsNotDeclared (methodId: string): void {
  if (methodId.includes('*')) return; // including to register for wildcards such as "*"
  if (allMethodsMap[methodId]) return;
  throw new Error('Attempting to add a method not declared in audit, methodId: "' + methodId + '". Please add it to components/audit/src/ApiMethods.ts#ALL_METHODS');
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
