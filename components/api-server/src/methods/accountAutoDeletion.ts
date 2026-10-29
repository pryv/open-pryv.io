/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/**
 * Account auto-deletion setting (personal token only): delete the account at
 * a date the holder picks, or after a period without use, with reminders.
 *
 * Only the account's own login sets it (never a delegated session). Arming a
 * schedule or bringing the deletion nearer needs the account password;
 * clearing it or moving it later does not. Every change is confirmed by mail,
 * clearing included, and that mail is the first notice of the schedule.
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
import type { Setting, Action } from 'business/src/autoDeletion/state.ts';
import { basicAccessAuthorizationCheck, getParamsValidation, requirePersonalAccess } from './helpers/commonFunctions.ts';
import * as methodsSchema from '../schema/accountAutoDeletionMethods.ts';
import { createPasswordStepUp } from './helpers/passwordStepUp.ts';
import { getState, loadAccountFacts, computeSchedule, buildView, sendConfirmation } from './helpers/autoDeletion.ts';
import { autoDeletionConfig, availableActions, availableTriggers } from './helpers/autoDeletionPolicy.ts';

type Api = { register: (...args: unknown[]) => void };
type SetParams = {
  mode: 'default' | 'never' | 'date' | 'inactivity';
  date?: string;
  inactivityDays?: number;
  action?: Action;
  transfer?: unknown;
  acknowledgeNoReminders?: boolean;
  password?: string;
};

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

  async function answerView (context: MethodContext, result: ResultBag): Promise<void> {
    const user = userOf(context);
    const adConfig = autoDeletionConfig(config);
    const state = await getState();
    const setting = await state.getSetting(user.id);
    const facts = await loadAccountFacts(config, user);
    const prev = await state.getBookkeeping(user.id);
    const now = timestamp.now();
    const schedule = computeSchedule(adConfig, setting, facts, prev, now);
    result.autoDeletion = buildView({ config, adConfig, setting, facts, prev, schedule, now });
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
        const mode = params.mode;
        if (mode !== 'date' && params.date != null) return next(errors.invalidParametersFormat('"date" is only used with mode "date".', { param: 'date' }));
        if (mode !== 'inactivity' && params.inactivityDays != null) return next(errors.invalidParametersFormat('"inactivityDays" is only used with mode "inactivity".', { param: 'inactivityDays' }));
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
        if (armsOrShortens(before, after)) {
          if (params.password == null) return next(errors.autoDeletionPasswordRequired());
          const passwordErr = await checkPassword(user, params.password, context.source?.ip);
          if (passwordErr != null) return next(passwordErr);
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
        await state.saveBookkeeping(user.id, prev, b);
        if (await sendConfirmation(config, user, facts, schedule, now) && b != null) {
          const noticed = withNotice(b, now);
          await state.saveBookkeeping(user.id, b, noticed);
          schedule.evaluation.bookkeeping = noticed;
        }
        result.autoDeletion = buildView({ config, adConfig, setting, facts, prev, schedule, now });
        next();
      } catch (err) {
        next(asApiError(err));
      }
    }
  );
}
