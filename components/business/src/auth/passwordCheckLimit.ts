/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/**
 * `auth.passwordCheckConcurrency` / `auth.passwordCheckQueue`: how many
 * password hashes and checks (account passwords, the password history, OAuth
 * client secrets) one API worker runs at once, and how many wait for a turn.
 * Beyond that, or after a wait of 10 s, the call is refused: the API answers
 * 429 too-many-requests, the OAuth endpoints 503 temporarily_unavailable,
 * both with Retry-After. A refusal is not a failed attempt.
 * `passwordCheckConcurrency: 0` disables the limit.
 *
 * One shared reading for the boot validation, `bin/check-config.js` and the
 * worker that applies it, so the three can never disagree.
 */

const PASSWORD_CHECK_DEFAULTS = Object.freeze({ concurrency: 2, queue: 50 });

/** libuv's thread pool size when UV_THREADPOOL_SIZE is not set. */
const DEFAULT_THREADPOOL_SIZE = 4;

type Problem = { path: string[]; message: string };

type PasswordCheckReport = {
  /** The limits to apply, from the configured values or the defaults. */
  settings: { concurrency: number; queue: number };
  problems: Problem[];
  warnings: string[];
};

function isCount (v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v >= 0;
}

/**
 * @param auth The `auth` config block (or undefined).
 * @param threadPoolEnv The UV_THREADPOOL_SIZE environment value.
 */
function describePasswordCheckLimit (auth: unknown, threadPoolEnv: string | undefined = process.env.UV_THREADPOOL_SIZE): PasswordCheckReport {
  const block = (auth != null && typeof auth === 'object') ? auth as Record<string, unknown> : {};
  const problems: Problem[] = [];
  const warnings: string[] = [];
  const settings: { concurrency: number; queue: number } = { ...PASSWORD_CHECK_DEFAULTS };

  const concurrency = block.passwordCheckConcurrency;
  if (concurrency != null) {
    if (isCount(concurrency)) settings.concurrency = concurrency;
    else problems.push({ path: ['auth', 'passwordCheckConcurrency'], message: 'must be an integer >= 0 (0 disables the limit)' });
  }
  const queue = block.passwordCheckQueue;
  if (queue != null) {
    if (isCount(queue)) settings.queue = queue;
    else problems.push({ path: ['auth', 'passwordCheckQueue'], message: 'must be an integer >= 0 (0 refuses as soon as every slot is busy)' });
  }

  const parsedPool = Number.parseInt(threadPoolEnv ?? '', 10);
  const threadPool = Number.isInteger(parsedPool) && parsedPool > 0 ? parsedPool : DEFAULT_THREADPOOL_SIZE;
  if (problems.length === 0 && settings.concurrency >= threadPool) {
    warnings.push(`auth.passwordCheckConcurrency (${settings.concurrency}) is not below the thread pool size (${threadPool}, UV_THREADPOOL_SIZE): ` +
      'password checks can then occupy every thread and stall file and DNS work. Keep it below the thread pool size.');
  }
  return { settings, problems, warnings };
}

export { describePasswordCheckLimit, PASSWORD_CHECK_DEFAULTS };
export type { PasswordCheckReport };
