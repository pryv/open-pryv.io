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
 * on. A step must not hold the deletion on a remote peer: deliveries to
 * another core are sent without being awaited.
 */

type DeletedAccount = { id: string; username: string };
type TeardownStep = (account: DeletedAccount) => Promise<void>;
type WarnLogger = { warn: (msg: string, ctx?: Record<string, unknown>) => void };

// Keyed by name: a method module registered twice (tests do) replaces its
// step instead of running it twice.
const steps = new Map<string, TeardownStep>();

function setDeletionTeardownStep (name: string, step: TeardownStep): void {
  steps.set(name, step);
}

async function runDeletionTeardownSteps (account: DeletedAccount, logger: WarnLogger): Promise<void> {
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
}

export { setDeletionTeardownStep, runDeletionTeardownSteps };
export type { DeletedAccount, TeardownStep };
