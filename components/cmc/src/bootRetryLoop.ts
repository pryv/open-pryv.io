/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

/**
 * CMC plugin — retry-loop bootstrap helper.
 *
 * Wires `RetryScheduler` onto the api-server worker, gated on:
 *   1. config `cmc.retryLoop.enabled` (default false).
 *   2. cluster.worker?.id === 1 — only ONE worker runs the loop so we
 *      don't dispatch the same retry from N workers in parallel. In
 *      non-cluster mode (no worker id), starts unconditionally.
 *
 * Operator must supply a `userIdsProvider` callback that yields the
 * userIds to scan each tick. Deliberately not derived from the platform
 * — deployments scope this differently (shard-aware, recent-activity-
 * only, etc.). If absent, the loop is not started even when enabled.
 *
 * Returns the `RetryScheduler` instance (or null when disabled) so
 * tests + operators can introspect / stop it.
 */

const { RetryScheduler } = require('./retryScheduler.ts');
const { dispatch } = require('./dispatch.ts');

type MallLike = Record<string, any>;
type Identity = { username?: string; host?: string; apiEndpoint?: string; [k: string]: unknown };
type BootDeps = {
  config: { get: (key: string) => unknown };
  mall: MallLike;
  selfIdentityFor: (userId: string) => Identity;
  fetch: (url: string, init?: Record<string, unknown>) => Promise<Response>;
  logger?: { debug: Function; warn: Function; info?: Function };
  userIdsProvider?: () => Promise<string[]> | string[];
  // Optional: a cluster worker id check. Defaults to checking the
  // node:cluster module if available.
  isLoopWorker?: () => boolean;
};

function defaultIsLoopWorker (): boolean {
  try {
    const cluster = require('node:cluster');
    // Worker mode → only worker id 1 runs the loop.
    if (cluster.isWorker) {
      return cluster.worker?.id === 1;
    }
    // Standalone / primary process: always run.
    return true;
  } catch (_e) {
    return true;
  }
}

/**
 * Start the retry-loop scheduler if config allows it + we're the
 * designated worker. Returns the scheduler instance or null.
 *
 * The caller is responsible for `await scheduler.stop()` on shutdown
 * if it wants a graceful drain.
 */
function startRetryLoopIfEnabled (deps: BootDeps): unknown {
  const enabled = deps.config.get('cmc:retryLoop:enabled');
  if (enabled !== true) {
    deps.logger?.debug?.('cmc/bootRetryLoop: disabled by config');
    return null;
  }
  if (deps.userIdsProvider == null) {
    deps.logger?.warn?.('cmc/bootRetryLoop: enabled but no userIdsProvider supplied — loop not started');
    return null;
  }
  const isLoopWorker = (deps.isLoopWorker ?? defaultIsLoopWorker)();
  if (!isLoopWorker) {
    deps.logger?.debug?.('cmc/bootRetryLoop: not the designated worker — skipping');
    return null;
  }

  const intervalMs = deps.config.get('cmc:retryLoop:intervalMs') || 60_000;
  const perUserLimit = deps.config.get('cmc:retryLoop:perUserLimit') || 100;

  const retryDeps = {
    mall: deps.mall,
    dispatch,
    dispatchDeps: {
      mall: deps.mall,
      fetch: deps.fetch,
      logger: deps.logger,
      selfIdentityFor: deps.selfIdentityFor,
    },
    logger: deps.logger,
  };

  const scheduler = new RetryScheduler({
    retryDeps,
    userIdsProvider: deps.userIdsProvider,
    perUserLimit,
    logger: deps.logger,
  });
  scheduler.start(intervalMs);
  deps.logger?.info?.('cmc/bootRetryLoop: started', { intervalMs, perUserLimit });
  return scheduler;
}

export {
  startRetryLoopIfEnabled,
  defaultIsLoopWorker,
};
