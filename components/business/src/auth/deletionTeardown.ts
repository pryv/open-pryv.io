/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/**
 * Account-deletion teardown steps contributed by plugins.
 *
 * Some state an account holds reaches OTHER accounts: a delegation it
 * controls lives on the controlled account, a consent grant it was given
 * lives on the granting account. Wiping the deleted account's own rows leaves
 * those behind, still usable. A plugin that owns such a relationship registers
 * a step here; `auth.delete` runs every step before it erases anything, while
 * the account's records still name its counterparties.
 *
 * Best-effort by contract: a step that fails is logged and the deletion goes
 * on. A delivery to another account (often on another core) is not awaited
 * by its step but handed to trackTeardownDelivery: once every step ran, the
 * deliveries are awaited for DELIVERY_WAIT_MS at most, so they are sent
 * before the deletion answers without a slow peer holding it.
 */

import { AsyncLocalStorage } from 'node:async_hooks';

type DeletedAccount = { id: string; username: string };
type TeardownStep = (account: DeletedAccount) => Promise<void>;
type WarnLogger = { warn: (msg: string, ctx?: Record<string, unknown>) => void };

// Keyed by name: a method module registered twice (tests do) replaces its
// step instead of running it twice.
const steps = new Map<string, TeardownStep>();

// The deliveries of each deletion, collected while its steps run (one list per
// deletion, so concurrent deletions each wait for their own).
const DELIVERY_WAIT_MS = 5000;
const deliveriesOfThisDeletion = new AsyncLocalStorage<Array<Promise<unknown>>>();

function trackTeardownDelivery (delivery: Promise<unknown>): void {
  const settled = delivery.catch(() => { /* each delivery logs its own failure */ });
  deliveriesOfThisDeletion.getStore()?.push(settled);
}

function setDeletionTeardownStep (name: string, step: TeardownStep): void {
  steps.set(name, step);
}

async function runDeletionTeardownSteps (account: DeletedAccount, logger: WarnLogger, waitMs = DELIVERY_WAIT_MS): Promise<void> {
  const mine: Array<Promise<unknown>> = [];
  await deliveriesOfThisDeletion.run(mine, async () => {
    for (const [name, step] of steps) {
      try {
        await step(account);
      } catch (err) {
        logger.warn('account deletion: teardown step "' + name + '" failed (deletion continues)', {
          userId: account.id,
          error: String((err as Error)?.message ?? err),
        });
      }
    }
  });
  if (mine.length === 0) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = await Promise.race([
    Promise.allSettled(mine).then(() => false),
    new Promise<boolean>((resolve) => { timer = setTimeout(() => resolve(true), waitMs); })
  ]);
  if (timer != null) clearTimeout(timer);
  if (timedOut) {
    logger.warn('account deletion: deliveries to other accounts still pending after ' + waitMs + ' ms (they go on)', { userId: account.id });
  }
}

/**
 * Deletion guards: a plugin may hold a deletion that would leave another
 * account without any way in (e.g. a controlled account with no email, whose
 * only access was the deleted delegate). A guard answers what it objects to,
 * or null; `auth.delete` refuses the account owner's deletion on any
 * objection (an admin-key deletion goes through, logged).
 */
type DeletionObjection = { message: string; data: Record<string, unknown> };
type DeletionGuard = (account: DeletedAccount) => Promise<DeletionObjection | null>;
const guards = new Map<string, DeletionGuard>();

function setDeletionGuard (name: string, guard: DeletionGuard): void {
  guards.set(name, guard);
}

async function runDeletionGuards (account: DeletedAccount, logger: WarnLogger): Promise<DeletionObjection[]> {
  const objections: DeletionObjection[] = [];
  for (const [name, guard] of guards) {
    try {
      const objection = await guard(account);
      if (objection != null) objections.push(objection);
    } catch (err) {
      logger.warn('account deletion: guard "' + name + '" failed (not objecting)', {
        userId: account.id,
        error: String((err as Error)?.message ?? err),
      });
    }
  }
  return objections;
}

export { setDeletionTeardownStep, runDeletionTeardownSteps, trackTeardownDelivery, setDeletionGuard, runDeletionGuards };
export type { DeletionObjection };
export type { DeletedAccount, TeardownStep };
