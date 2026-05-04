/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
import type {} from 'node:fs';


/**
 * Plan 54 Phase D — request/response IPC client used by the admin
 * `force-renew` route. The worker sends `acme:force-renew` to the master
 * which holds the AcmeOrchestrator, and resolves on the matching
 * `acme:force-renew:reply` (matched by `requestId`).
 *
 * Kept in a dedicated file so the route stays declarative and so unit
 * tests can stub `processHandle` without spawning a real cluster.
 */

const { randomUUID } = require('node:crypto');

const DEFAULT_TIMEOUT_MS = 180_000;

/**
 * @param {Object} opts
 * @param {string|undefined} opts.hostname - optional override; master falls back to primary.
 * @param {number} [opts.timeoutMs=180000] - generous default; ACME with DNS-01 + 15s propagate wait can take a couple of minutes.
 * @param {NodeJS.Process} [opts.processHandle=process] - injectable for tests.
 * @returns {Promise<{
 *   ok: boolean,
 *   hostname?: string,
 *   issuedAt?: number,
 *   expiresAt?: number,
 *   error?: string
 * }>}
 */
async function forceRenew ({ hostname, timeoutMs = DEFAULT_TIMEOUT_MS, processHandle = process }: any = {}) {
  if (typeof processHandle.send !== 'function') {
    return { ok: false, error: 'force-renew unavailable: process not running under cluster (no IPC channel)' };
  }
  const requestId = randomUUID();

  return await new Promise((resolve) => {
    let settled = false;
    const onMsg = (msg) => {
      if (settled) return;
      if (!msg || msg.type !== 'acme:force-renew:reply' || msg.requestId !== requestId) return;
      settled = true;
      clearTimeout(timer);
      processHandle.removeListener('message', onMsg);
      resolve({
        ok: !!msg.ok,
        hostname: msg.hostname,
        issuedAt: msg.issuedAt,
        expiresAt: msg.expiresAt,
        error: msg.error
      });
    };
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      processHandle.removeListener('message', onMsg);
      resolve({ ok: false, error: `force-renew timed out after ${timeoutMs}ms (master IPC reply missing)` });
    }, timeoutMs);
    processHandle.on('message', onMsg);
    try {
      processHandle.send({ type: 'acme:force-renew', requestId, hostname: hostname || null });
    } catch (err) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      processHandle.removeListener('message', onMsg);
      resolve({ ok: false, error: 'force-renew IPC send failed: ' + err.message });
    }
  });
}

module.exports = { forceRenew };
