/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/**
 * Account auto-deletion setting (personal token only): delete the account at
 * a date the holder picks, or after a period without use, with reminders; or
 * transfer it to a beneficiary, who then becomes its controller.
 *
 * Only the account's own login sets it (never a delegated session). Arming a
 * schedule, bringing the deletion nearer, or setting / changing a transfer
 * needs the account password; clearing it or moving it later does not. Every
 * change is confirmed by mail, clearing included, and that mail is the first
 * notice of the schedule.
 *
 * The beneficiary acts through two public methods, the mailed link being the
 * credential: `account.transferClaim` and `account.transferDecline`.
 */

import { ready, getLogger } from '@pryv/boiler';
import timestamp from 'unix-timestamp';
import type { MethodNext as Next, ResultBag } from './_types.ts';
import type { MethodContext } from 'business/src/MethodContext.ts';
import { factory as errors, APIError } from 'errors';
import { isDelegationDerivedAccess } from 'delegation';
import { getStorageLayer } from 'storage';
import { DAY_SECONDS, withNotice, effectivePolicy } from 'business/src/autoDeletion/deadline.ts';
import type { Policy } from 'business/src/autoDeletion/deadline.ts';
import { isOpenTransfer } from 'business/src/autoDeletion/state.ts';
import type { Setting, Action, TransferSetting, TransferRecord, Identity } from 'business/src/autoDeletion/state.ts';
import { linkTokenMatches, newSalt } from 'business/src/autoDeletion/transfer.ts';
import { completeTransfer, cancelTransfer, keepAccount, lapseTransfer } from 'business/src/autoDeletion/transferFlow.ts';
import type { TransferFlowDeps } from 'business/src/autoDeletion/transferFlow.ts';
import { getUsersRepository } from 'business/src/users/index.ts';
import { normalizePasswordAttempts } from 'business/src/auth/passwordAttempts.ts';
import { passwordIpRefusal, countPasswordIpFailure } from 'business/src/auth/passwordIpThrottle.ts';
import { setAuditAccessId, AuditAccessIds } from 'audit/src/MethodContextUtils.ts';
import { basicAccessAuthorizationCheck, getParamsValidation, requirePersonalAccess, refuseGenericDispatch, getTrustedAppCheck } from './helpers/commonFunctions.ts';
import * as methodsSchema from '../schema/accountAutoDeletionMethods.ts';
import { createPasswordStepUp } from './helpers/passwordStepUp.ts';
import { getState, loadAccountFacts, computeSchedule, buildView, sendConfirmation, sendTransferMail } from './helpers/autoDeletion.ts';
import type { AccountFacts } from './helpers/autoDeletion.ts';
import { autoDeletionConfig, availableActions, availableTriggers, transferLinkKey, transferIdentityKey, mailSwitchedOn } from './helpers/autoDeletionPolicy.ts';
import { getTransferDelegation } from './helpers/transferDelegation.ts';

type Api = { register: (...args: unknown[]) => void };
type TransferParams = { email?: string; name?: string; dateOfBirth?: string; notifyBeneficiary?: 'atSetup' | 'atTrigger'; fallback?: 'delete' | 'keep' };
type SetParams = {
  mode: 'default' | 'never' | 'date' | 'inactivity';
  date?: string;
  inactivityDays?: number;
  action?: Action;
  transfer?: TransferParams;
  acknowledgeNoReminders?: boolean;
  password?: string;
};
type UserRef = { id: string; username: string };

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const DAY_OF_BIRTH = /^(\d{4})-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;
/** Longest a delegation invite of a claim stays open (the window may be longer: a lapsed invite is issued again). */
const CLAIM_INVITE_TTL_SECONDS = 30 * DAY_SECONDS;
/** Failed claims of one transfer after which a warning is logged (they refuse nothing). */
const FAILED_CLAIMS_WARNING = 10;

/** The transfer settings, checked; or the error to answer. */
function readTransfer (params: TransferParams | undefined, actions: string[], ownEmail: string | null, namedMailOn: boolean): { setting: TransferSetting; identity?: Identity } | APIError {
  const p = params ?? {};
  const invalid = (param: string, message: string) => errors.autoDeletionTransferInvalid(message, { param });
  const email = typeof p.email === 'string' ? p.email.trim() : '';
  if (!EMAIL.test(email)) return invalid('email', '"transfer.email" must be the email address of the beneficiary.');
  if (ownEmail != null && email.toLowerCase() === ownEmail.toLowerCase()) return invalid('email', 'The beneficiary must be someone else: "transfer.email" is the address of this account.');
  if (p.notifyBeneficiary == null) return invalid('notifyBeneficiary', '"transfer.notifyBeneficiary" is required: "atSetup" or "atTrigger".');
  if (p.fallback == null) return invalid('fallback', '"transfer.fallback" is required: "delete" or "keep".');
  if (p.notifyBeneficiary === 'atSetup' && !namedMailOn) {
    return errors.autoDeletionTransferInvalid('"transfer.notifyBeneficiary" "atSetup" is not available on this platform (the mail that tells the beneficiary is off): use "atTrigger".', { param: 'notifyBeneficiary', reason: 'named-mail-off' });
  }
  if (p.fallback === 'delete' && !actions.includes('delete')) {
    return errors.autoDeletionTransferInvalid('"transfer.fallback" "delete" is not available on this platform (account holders cannot delete their account): use "keep".', { param: 'fallback', available: ['keep'] });
  }
  const setting: TransferSetting = { email, notifyBeneficiary: p.notifyBeneficiary, fallback: p.fallback };
  if (p.name === undefined && p.dateOfBirth === undefined) return { setting };
  const name = typeof p.name === 'string' ? p.name.trim() : '';
  const dateOfBirth = typeof p.dateOfBirth === 'string' ? p.dateOfBirth.trim() : '';
  if (dateOfBirth !== '') {
    const m = DAY_OF_BIRTH.exec(dateOfBirth);
    const day = m == null ? null : new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
    if (day == null || day.getUTCDate() !== Number(m![3]) || day.getTime() > Date.now()) {
      return invalid('dateOfBirth', '"transfer.dateOfBirth" must be a past day, YYYY-MM-DD.');
    }
  }
  const identity: Identity = {};
  if (name !== '') identity.name = name;
  if (dateOfBirth !== '') identity.dateOfBirth = dateOfBirth;
  return { setting, identity };
}

/** Whether `next` sets a transfer, or changes who gets the account or what happens without a claim. */
export function changesTransfer (prev: Setting | null, next: Setting | null, identitySent: boolean): boolean {
  if (next?.action !== 'transfer' || next.transfer == null) return false;
  const p = prev?.action === 'transfer' ? prev.transfer : undefined;
  if (p == null || identitySent) return true;
  return p.email.toLowerCase() !== next.transfer.email.toLowerCase() || p.fallback !== next.transfer.fallback || p.notifyBeneficiary !== next.transfer.notifyBeneficiary;
}

// An instant: a calendar date, a time, and an offset or `Z`. A date alone
// is a different instant in every timezone, so it is refused.
const INSTANT = /^(\d{4})-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])T([01]\d|2[0-3]):[0-5]\d(:[0-5]\d(\.\d{1,9})?)?(Z|[+-]([01]\d|2[0-3]):?[0-5]\d)$/;

/** Pryv seconds of an ISO-8601 instant, or null (no offset, a date alone, a day the month does not have). */
export function parseInstant (value: string): number | null {
  const m = INSTANT.exec(value);
  if (m == null) return null;
  const [year, month, day] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (new Date(Date.UTC(year, month - 1, day)).getUTCDate() !== day) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms / 1000 : null;
}

function asApiError (err: unknown) {
  return err instanceof APIError ? err : errors.unexpectedError(err);
}

function userOf (context: MethodContext): { id: string; username: string } {
  const user = context.user;
  if (user?.id == null) throw errors.unexpectedError('auto-deletion: method called without a loaded user');
  return { id: user.id, username: user.username };
}

/**
 * Whether going from the effective policy `prev` to `next` arms a schedule or
 * brings the deletion nearer (the password is then required). Judged on the
 * policy in effect, not the holder's own setting: leaving "never" for the
 * platform's preset arms one too.
 */
export function armsOrShortens (prev: Policy | null, next: Policy | null): boolean {
  if (next == null || (next.mode !== 'date' && next.mode !== 'inactivity')) return false;
  if (prev == null || prev.mode === 'never' || prev.mode !== next.mode) return true;
  if (prev.action === 'transfer' && next.action === 'delete') return true;
  if (next.mode === 'inactivity') return (next.inactivityDays as number) < (prev.inactivityDays as number);
  return (next.date as number) < (prev.date as number);
}

export default async function (api: Api) {
  const config = await ready();
  const logger = getLogger('methods:accountAutoDeletion');
  const storageLayer = await getStorageLayer();
  const checkPassword = createPasswordStepUp({
    config,
    profileStorage: storageLayer.profile,
    logger,
    mismatchError: () => errors.autoDeletionWrongPassword()
  });

  function checkEnabled (_context: MethodContext, _params: unknown, _result: ResultBag, next: Next) {
    if (!autoDeletionConfig(config).enabled) {
      return next(errors.unavailableMethod('Account auto-deletion is disabled on this platform.'));
    }
    next();
  }

  function flowDeps (state: Awaited<ReturnType<typeof getState>>): TransferFlowDeps<AccountFacts> {
    return {
      state,
      config: autoDeletionConfig(config),
      now: () => timestamp.now(),
      sendTransferMail: (account, facts, notice) => sendTransferMail(config, account, facts, notice)
    };
  }

  async function answerView (context: MethodContext, result: ResultBag): Promise<void> {
    const user = userOf(context);
    const adConfig = autoDeletionConfig(config);
    const state = await getState();
    const setting = await state.getSetting(user.id);
    const facts = await loadAccountFacts(config, user);
    const prev = await state.getBookkeeping(user.id);
    const transfer = await state.getTransfer(user.id);
    const now = timestamp.now();
    const schedule = computeSchedule(adConfig, setting, facts, prev, now);
    result.autoDeletion = buildView({ config, adConfig, setting, facts, prev, schedule, now, transfer, failedClaims: await state.getFailedClaims(user.id, transfer?.claimSalt) });
  }

  api.register('account.getAutoDeletion',
    basicAccessAuthorizationCheck,
    checkEnabled,
    getParamsValidation(methodsSchema.get.params),
    requirePersonalAccess,
    async function getAutoDeletion (context: MethodContext, _params: unknown, result: ResultBag, next: Next) {
      try {
        await answerView(context, result);
        next();
      } catch (err) {
        next(asApiError(err));
      }
    }
  );

  api.register('account.setAutoDeletion',
    basicAccessAuthorizationCheck,
    checkEnabled,
    getParamsValidation(methodsSchema.set.params),
    requirePersonalAccess,
    function refuseDelegatedAccess (context: MethodContext, _params: unknown, _result: ResultBag, next: Next) {
      if (isDelegationDerivedAccess(context.access as unknown as Parameters<typeof isDelegationDerivedAccess>[0])) {
        return next(errors.autoDeletionDelegateRefused());
      }
      next();
    },
    async function setAutoDeletion (context: MethodContext, params: SetParams, result: ResultBag, next: Next) {
      try {
        const user = userOf(context);
        const adConfig = autoDeletionConfig(config);
        const now = timestamp.now();
        const state = await getState();
        const prevSetting = await state.getSetting(user.id);
        const facts = await loadAccountFacts(config, user);

        // The requested setting (null: follow the platform's policy).
        let setting: Setting | null = null;
        let identity: Identity | undefined;
        const mode = params.mode;
        if (mode !== 'date' && params.date != null) return next(errors.invalidParametersFormat('"date" is only used with mode "date".', { param: 'date' }));
        if (mode !== 'inactivity' && params.inactivityDays != null) return next(errors.invalidParametersFormat('"inactivityDays" is only used with mode "inactivity".', { param: 'inactivityDays' }));
        if (params.transfer != null && (params.action !== 'transfer' || (mode !== 'date' && mode !== 'inactivity'))) {
          return next(errors.invalidParametersFormat('"transfer" is only used with action "transfer" and mode "date" or "inactivity".', { param: 'transfer' }));
        }
        if (mode === 'never') {
          if (!adConfig.allowUserOptOut && adConfig.inactivity.defaultDays != null && facts.presetApplies) {
            return next(errors.autoDeletionOptOutNotAllowed());
          }
          setting = { mode: 'never', action: 'delete', updatedAt: now };
        } else if (mode === 'date' || mode === 'inactivity') {
          if (!adConfig.userOverride) {
            return next(errors.autoDeletionOverrideNotAllowed('user-override-disabled'));
          }
          const action: Action = params.action ?? 'delete';
          const actions = availableActions(config);
          if (!actions.includes(action)) return next(errors.autoDeletionActionNotAllowed(action, actions));
          setting = { mode, action, updatedAt: now };
          if (action === 'transfer') {
            const read = readTransfer(params.transfer, actions, facts.email, mailSwitchedOn(config, 'accountTransferNamed'));
            if (read instanceof APIError) return next(read);
            setting.transfer = read.setting;
            identity = read.identity;
          }
          if (mode === 'date') {
            if (params.date == null) return next(errors.invalidParametersFormat('"date" is required with mode "date".', { param: 'date' }));
            const date = parseInstant(params.date);
            if (date == null) {
              return next(errors.invalidParametersFormat('"date" must be an ISO-8601 instant with a time and an offset or "Z" (e.g. 2027-06-01T23:59:59+02:00); a date alone is refused.', { param: 'date' }));
            }
            const earliest = now + adConfig.date.minLeadDays * DAY_SECONDS;
            if (date < earliest) {
              return next(errors.autoDeletionOutOfBounds(`"date" must be at least ${adConfig.date.minLeadDays} days from now.`, { param: 'date', minLeadDays: adConfig.date.minLeadDays }));
            }
            setting.date = date;
          } else {
            if (!availableTriggers(config).includes('inactivity')) {
              return next(errors.autoDeletionOverrideNotAllowed('inactivity-unavailable'));
            }
            const days = params.inactivityDays;
            if (days == null) return next(errors.invalidParametersFormat('"inactivityDays" is required with mode "inactivity".', { param: 'inactivityDays' }));
            const { minDays, maxDays } = adConfig.inactivity;
            if (days < minDays || days > maxDays) {
              return next(errors.autoDeletionOutOfBounds(`"inactivityDays" must be between ${minDays} and ${maxDays}.`, { param: 'inactivityDays', minDays, maxDays }));
            }
            setting.inactivityDays = days;
          }
          if (!facts.notifiable) {
            if (params.acknowledgeNoReminders !== true) {
              return next(errors.autoDeletionNoEmail(facts.mail === 'not-configured' ? 'mail-not-configured' : 'no-email'));
            }
            setting.acknowledgedNoReminders = true;
          }
        }
        const before = effectivePolicy(prevSetting, adConfig, facts.presetApplies);
        const after = effectivePolicy(setting, adConfig, facts.presetApplies);
        // Who gets the account is as sensitive as when it goes: setting or
        // changing a transfer needs the password too.
        if (armsOrShortens(before, after) || changesTransfer(prevSetting, setting, identity !== undefined)) {
          if (params.password == null) return next(errors.autoDeletionPasswordRequired());
          const passwordErr = await checkPassword(user, params.password, context.source?.ip);
          if (passwordErr != null) return next(passwordErr);
        }

        // The beneficiary's name and date of birth: replaced when sent,
        // kept for the same beneficiary, erased otherwise.
        if (setting?.transfer != null) {
          const sameBeneficiary = prevSetting?.action === 'transfer' && prevSetting.transfer?.email.toLowerCase() === setting.transfer.email.toLowerCase();
          if (identity !== undefined) {
            if (identity.name != null || identity.dateOfBirth != null) {
              const key = transferIdentityKey(config);
              if (key == null) return next(errors.autoDeletionTransferInvalid('Name and date of birth cannot be stored on this platform (no key).', { reason: 'no-identity-key' }));
              await state.setIdentity(user.id, identity, key, context.access?.id ?? 'system');
              setting.transfer.identityGiven = true;
            } else {
              await state.eraseIdentity(user.id);
            }
          } else if (sameBeneficiary && prevSetting?.transfer?.identityGiven === true) {
            setting.transfer.identityGiven = true;
          } else if (prevSetting?.transfer?.identityGiven === true) {
            await state.eraseIdentity(user.id);
          }
        } else if (prevSetting?.transfer?.identityGiven === true) {
          await state.eraseIdentity(user.id);
        }

        // The field keeps every version: clearing a setting that is not there
        // writes nothing.
        if (prevSetting != null || setting != null) {
          await state.setSetting(user.id, setting, context.access?.id ?? 'system');
        }

        // Schedule under the new setting; the confirmation is its first notice.
        const prev = await state.getBookkeeping(user.id);
        const schedule = computeSchedule(adConfig, setting, facts, prev, now);
        const b = schedule.evaluation.bookkeeping;
        const dueAt = b == null ? null : (b.deleteAt ?? b.deadline);
        const transfer = await updateTransferRecord(user, facts, state, setting, now, dueAt != null && dueAt > now);
        await state.saveBookkeeping(user.id, prev, b);
        if (await sendConfirmation(config, user, facts, schedule, now, setting) && b != null) {
          const noticed = withNotice(b, now);
          await state.saveBookkeeping(user.id, b, noticed);
          schedule.evaluation.bookkeeping = noticed;
        }
        result.autoDeletion = buildView({ config, adConfig, setting, facts, prev, schedule, now, transfer, failedClaims: await state.getFailedClaims(user.id, transfer?.claimSalt) });
        next();
      } catch (err) {
        next(asApiError(err));
      }
    }
  );

  /**
   * The transfer record after a change of the holder's setting: a transfer
   * that no longer applies (other beneficiary, other action, or a claim
   * window open while the new schedule is not due yet) is cancelled, a
   * pending invite withdrawn; a beneficiary to tell at setup is told now.
   */
  async function updateTransferRecord (user: UserRef, facts: AccountFacts, state: Awaited<ReturnType<typeof getState>>, setting: Setting | null, now: number,
    dueLater: boolean): Promise<TransferRecord | null> {
    let record = await state.getTransfer(user.id);
    const t = setting?.action === 'transfer' ? setting.transfer : undefined;
    const sameBeneficiary = t != null && record != null && record.email.toLowerCase() === t.email.toLowerCase();
    const windowMoot = (record?.status === 'open' || record?.status === 'claimed') && dueLater;
    if (isOpenTransfer(record) && (!sameBeneficiary || windowMoot)) {
      if (record.status === 'claimed' && record.claimedBy != null) {
        try {
          await getTransferDelegation()?.withdraw(user, record.claimedBy.username);
        } catch (err) {
          logger.warn(`auto-deletion: the pending invite of account "${user.username}" to "${record.claimedBy.username}" was not withdrawn: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
      // The identity was already settled with the setting above.
      record = await cancelTransfer(flowDeps(state), user, facts, record, { reason: 'owner-change', mailOwner: false, keepIdentity: true });
    }
    if (t?.notifyBeneficiary === 'atSetup' && !(isOpenTransfer(record) && sameBeneficiary) && !(windowMoot && sameBeneficiary)) {
      record = { email: t.email, status: 'named', createdAt: now, declineSalt: newSalt() };
      await state.saveTransfer(user.id, record);
      const outcome = await sendTransferMail(config, user, facts, { kind: 'named', to: 'beneficiary', record, setting, now });
      if (outcome === 'sent') {
        record = { ...record, namedAt: now };
        await state.saveTransfer(user.id, record);
      }
    }
    return record;
  }

  // ---- the beneficiary's methods (public, the mailed link is the credential)

  type TrustedAppAuth = ReturnType<Parameters<typeof getTrustedAppCheck>[0]>;
  const requireTrustedApp = getTrustedAppCheck(() => (config.get('auth') ?? {}) as TrustedAppAuth);

  /** The account of the path, or null. */
  async function ownerOf (context: MethodContext): Promise<{ id: string; username: string } | null> {
    const username = context.user?.username;
    if (typeof username !== 'string' || username === '') return null;
    const user = await (await getUsersRepository()).getUserByUsername(username) as { id?: string; username?: string } | null;
    return user?.id != null ? { id: user.id, username: user.username ?? username } : null;
  }

  /** Refuses a source that spent its budget of failed secrets (shared with passwords). */
  async function ipRefusal (context: MethodContext): Promise<Error | null> {
    return await passwordIpRefusal(context.source?.ip, normalizePasswordAttempts(config.get('auth:passwordAttempts')).perIp);
  }

  async function countFailure (context: MethodContext): Promise<void> {
    await countPasswordIpFailure(context.source?.ip, normalizePasswordAttempts(config.get('auth:passwordAttempts')).perIp);
  }

  api.register('account.transferClaim',
    refuseGenericDispatch,
    checkEnabled,
    getParamsValidation(methodsSchema.transferClaim.params),
    requireTrustedApp,
    async function transferClaim (context: MethodContext, params: { token: string; claimant: string }, result: ResultBag, next: Next) {
      try {
        const refused = await ipRefusal(context);
        if (refused != null) return next(refused);
        const owner = await ownerOf(context);
        const state = await getState();
        let record = owner != null ? await state.getTransfer(owner.id) : null;
        const key = transferLinkKey(config);
        const live = record != null && (record.status === 'open' || record.status === 'claimed' || record.status === 'completed');
        // The link first: a valid one always proceeds. Wrong ones are counted
        // for the owner to see, and refuse nothing else (a cap would let anyone
        // who knows the username lock the beneficiary out, and tell them a
        // transfer is open).
        if (owner == null || record == null || key == null || !live || !linkTokenMatches(key, 'claim', owner.id, record.claimSalt, params.token)) {
          await countFailure(context);
          if (owner != null && record?.claimSalt != null && (record.status === 'open' || record.status === 'claimed')) {
            const { count } = await state.countFailedClaim(owner.id, record.claimSalt, timestamp.now());
            if (count === FAILED_CLAIMS_WARNING) logger.warn(`auto-deletion: ${count} claims of the transfer of account "${owner.username}" with a wrong link`);
          }
          return next(errors.autoDeletionTransferInvalidLink());
        }
        const claimant = params.claimant.trim();
        const sameClaimant = record.claimedBy != null && record.claimedBy.username.toLowerCase() === claimant.toLowerCase();
        if (record.claimedBy != null && !sameClaimant) {
          logger.warn(`auto-deletion: claim of the transfer of account "${owner.username}" by "${claimant}" refused: claimed by "${record.claimedBy.username}"`);
          return next(errors.autoDeletionTransferClaimed());
        }
        if (record.status === 'completed') {
          result.transfer = { status: 'completed', username: owner.username };
          return next();
        }
        const delegation = getTransferDelegation();
        if (delegation == null) return next(errors.unavailableMethod('Transfers need account delegation, which is off on this platform.'));
        const now = timestamp.now();
        let rel = await delegation.stateOf(owner, claimant);
        // An accepted invite completes whatever the clock says (as the sweep does).
        if (rel.status !== 'active' && record.endsAt != null && now >= record.endsAt) return next(errors.autoDeletionTransferExpired());
        if (rel.status === 'stale') {
          return next(errors.autoDeletionTransferInvalid('This account cannot claim the transfer: a former delegation of the same name must first be removed by the account holder.', { reason: 'stale-relationship' }));
        }
        const facts = await loadAccountFacts(config, owner);
        if (rel.status === 'active') {
          // The claimant controls the account (just accepted, or already did): done.
          if (record.claimedBy == null) record = { ...record, status: 'claimed', claimedBy: { username: claimant, hostSlug: rel.hostSlug, relId: rel.relId, at: now } };
          await completeTransfer(flowDeps(state), owner, facts, record);
          logger.warn(`auto-deletion: transfer of account "${owner.username}" completed: "${claimant}" controls it`);
          result.transfer = { status: 'completed', username: owner.username };
          return next();
        }
        // Bound to this claimant before the invite goes out: a second claimant
        // arriving meanwhile is refused.
        const before = await state.getTransfer(owner.id);
        if (before?.claimedBy != null && before.claimedBy.username.toLowerCase() !== claimant.toLowerCase()) {
          return next(errors.autoDeletionTransferClaimed());
        }
        const bound: TransferRecord = { ...record, status: 'claimed', claimedBy: { ...(record.claimedBy ?? {}), username: claimant, at: record.claimedBy?.at ?? now } };
        await state.saveTransfer(owner.id, bound);
        try {
          if (rel.status === 'invite' && rel.expired === true) {
            // The invite lapsed inside the window: issued again.
            await delegation.withdraw(owner, claimant);
            rel = { status: 'none' };
          }
          if (rel.status !== 'invite') {
            const ttl = Math.max(DAY_SECONDS, Math.min(CLAIM_INVITE_TTL_SECONDS, (bound.endsAt ?? now) - now));
            const invited = await delegation.invite(owner, claimant, ttl);
            rel = { status: 'invite', relId: invited.relId, hostSlug: invited.hostSlug };
          }
        } catch (err) {
          // Nothing is bound when no invite went out.
          if (record.claimedBy == null) await state.saveTransfer(owner.id, record);
          throw err;
        }
        // Two first claims at once both bound and invited: the record keeps the
        // last write, the other claimant's invite is withdrawn.
        const current = await state.getTransfer(owner.id);
        if (current?.claimedBy != null && current.claimedBy.username.toLowerCase() !== claimant.toLowerCase()) {
          await delegation.withdraw(owner, claimant);
          logger.warn(`auto-deletion: claim of the transfer of account "${owner.username}" by "${claimant}" refused: claimed by "${current.claimedBy.username}" at the same time`);
          return next(errors.autoDeletionTransferClaimed());
        }
        record = { ...bound, ...(current ?? {}), status: 'claimed', claimedBy: { ...bound.claimedBy!, relId: rel.relId, hostSlug: rel.hostSlug } };
        await state.saveTransfer(owner.id, record);
        logger.info(`auto-deletion: transfer of account "${owner.username}" claimed by "${claimant}": delegation invite out`);
        result.transfer = { status: 'invited', username: owner.username };
        next();
      } catch (err) {
        next(asApiError(err));
      }
    },
    setAuditAccessId(AuditAccessIds.TRANSFER_CLAIM_LINK)
  );

  api.register('account.transferDecline',
    refuseGenericDispatch,
    checkEnabled,
    getParamsValidation(methodsSchema.transferDecline.params),
    requireTrustedApp,
    async function transferDecline (context: MethodContext, params: { token: string }, result: ResultBag, next: Next) {
      try {
        const refused = await ipRefusal(context);
        if (refused != null) return next(refused);
        const owner = await ownerOf(context);
        const state = await getState();
        const record = owner != null ? await state.getTransfer(owner.id) : null;
        const key = transferLinkKey(config);
        const declinable = record != null && (record.status === 'named' || record.status === 'open' || record.status === 'claimed' || record.status === 'declined');
        if (owner == null || record == null || key == null || !declinable || !linkTokenMatches(key, 'decline', owner.id, record.declineSalt, params.token)) {
          await countFailure(context);
          return next(errors.autoDeletionTransferInvalidLink());
        }
        if (record.status !== 'declined' && record.closedReason !== 'declined') {
          const setting = await state.getSetting(owner.id);
          const facts = await loadAccountFacts(config, owner);
          const flow = flowDeps(state);
          const fallback = setting?.transfer?.fallback === 'delete' && availableActions(config).includes('delete') ? 'delete' : 'keep';
          if (record.status === 'open' || record.status === 'claimed') {
            // The window was open: the owner's fallback applies now. A claim
            // made meanwhile by the beneficiary is withdrawn.
            if (record.status === 'claimed' && record.claimedBy != null) {
              const delegation = getTransferDelegation();
              // Accepted already (from the claimant's delegation list): the
              // transfer is done, a decline comes too late.
              if (delegation != null && (await delegation.stateOf(owner, record.claimedBy.username)).status === 'active') {
                await completeTransfer(flow, owner, facts, record);
                logger.warn(`auto-deletion: decline of the transfer of account "${owner.username}" refused: "${record.claimedBy.username}" already controls it (completed)`);
                return next(errors.autoDeletionTransferClaimed());
              }
              try {
                await delegation?.withdraw(owner, record.claimedBy.username);
              } catch (err) {
                logger.warn(`auto-deletion: the pending invite of account "${owner.username}" to "${record.claimedBy.username}" was not withdrawn: ${err instanceof Error ? err.message : String(err)}`);
              }
            }
            if (fallback === 'keep') {
              const lapsed = await lapseTransfer(flow, owner, facts, record, 'declined');
              await state.saveTransfer(owner.id, { ...lapsed, status: 'declined' });
            } else {
              // Erased by the next sweep, as at the end of the window (guards
              // included; an accept that still lands before it completes the
              // transfer instead); nobody is left to identify.
              await state.saveTransfer(owner.id, { ...record, status: 'open', endsAt: timestamp.now(), closedReason: 'declined' });
              await state.eraseIdentity(owner.id);
              await sendTransferMail(config, owner, facts, { kind: 'cancelled', to: 'owner', record, setting, now: timestamp.now(), reason: 'declined' });
            }
          } else {
            await cancelTransfer(flow, owner, facts, record, { status: 'declined', reason: 'declined', mailOwner: true });
            if (fallback === 'delete' && setting != null) {
              const { transfer: _t, ...rest } = setting;
              await state.setSetting(owner.id, { ...rest, action: 'delete', updatedAt: timestamp.now() }, 'system');
            } else {
              await keepAccount(flow, owner);
            }
          }
          logger.info(`auto-deletion: the beneficiary declined the transfer of account "${owner.username}" (fallback: ${fallback})`);
        }
        result.declined = true;
        next();
      } catch (err) {
        next(asApiError(err));
      }
    },
    setAuditAccessId(AuditAccessIds.TRANSFER_DECLINE_LINK)
  );
}
