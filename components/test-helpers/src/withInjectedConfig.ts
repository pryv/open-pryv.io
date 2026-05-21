/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

const { getConfigUnsafe } = require('@pryv/boiler');

// Plan 61 Stage 1 — `injectTestConfig` wholesale-replaces the `'test'` nconf
// scope. Callers paired `inject(A)` with a later `inject({})` to "reset",
// which wiped any pre-existing test scope state (e.g. initCore's
// dnsLess/caching baseline) and leaked between sibling test files inside one
// mocha worker. These helpers snapshot the current `'test'` scope, then
// inject `deepMerge(snapshot, overrides)` so the baseline survives, and on
// exit restore the original snapshot.

function snapshotTestScope (config: any): any {
  // Reach into the nconf provider's named stores. The `'test'` scope was
  // installed via `store.add('test', { type: 'literal', store: configObject })`
  // in boiler/src/config.ts; `.store` here is the literal-source data object.
  const current = config?.store?.stores?.test?.store;
  if (current == null) return {};
  return structuredClone(current);
}

function isPlainObject (v: any): boolean {
  return v != null && typeof v === 'object' && !Array.isArray(v) &&
    (Object.getPrototypeOf(v) === Object.prototype || Object.getPrototypeOf(v) === null);
}

function deepMerge (base: any, overlay: any): any {
  if (!isPlainObject(base)) return structuredClone(overlay);
  if (!isPlainObject(overlay)) return structuredClone(overlay);
  const out: any = structuredClone(base);
  for (const key of Object.keys(overlay)) {
    const b = out[key];
    const o = overlay[key];
    out[key] = (isPlainObject(b) && isPlainObject(o)) ? deepMerge(b, o) : structuredClone(o);
  }
  return out;
}

/**
 * Inject `overrides` deep-merged onto the current `'test'` config scope.
 * Returns a restore() callable that reinstates the original snapshot.
 * Use in paired before/after hooks where a single async wrapper does not fit.
 */
export function injectTestConfigSnapshot (overrides: any): () => void {
  const config = getConfigUnsafe();
  const snapshot = snapshotTestScope(config);
  const merged = deepMerge(snapshot, overrides);
  config.injectTestConfig(merged);
  return function restore () {
    config.injectTestConfig(snapshot);
  };
}

/**
 * Run `body` with `overrides` injected into the `'test'` config scope.
 * Restores the previous scope state on body exit (success or throw).
 */
export async function withInjectedConfig<T> (
  overrides: any,
  body: () => Promise<T> | T
): Promise<T> {
  const restore = injectTestConfigSnapshot(overrides);
  try {
    return await body();
  } finally {
    restore();
  }
}

export default { withInjectedConfig, injectTestConfigSnapshot };
