/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/**
 * Plan 34 Phase 4a — POST /system/admin/cores/ack handler.
 *
 * Called by a freshly bootstrapped core to confirm it has joined. The
 * one-time join token from the bundle authenticates the call: if it
 * verifies, we burn the token, flip the matching core's `available` bit to
 * true and return a cluster snapshot so the caller can sanity-check what
 * it's joining.
 *
 * The handler is decoupled from Express so it can be unit-tested with a
 * fake `platformDB` and an in-memory `tokenStore`. The route wiring in
 * `routes/system.js` is a thin adapter over this function.
 *
 * Possible return.statusCode values:
 *   200 — token verified, core marked available
 *   400 — malformed body (missing coreId/token)
 *   401 — token unknown / expired / already-consumed / coreId mismatch
 *   404 — token valid but no matching core-info row in PlatformDB
 *   500 — internal failure (caller should re-raise / log)
 */

const VALID_REASONS = new Set(['unknown', 'expired', 'already-consumed', 'invalid-format']);

/**
 * @param {Object} deps
 * @param {Object} deps.tokenStore - business/src/bootstrap/TokenStore instance
 * @param {Object} deps.platformDB - exposes getCoreInfo / setCoreInfo / getAllCoreInfos / getDnsRecord
 * @returns {(req: { body: Object, ip?: string }) => Promise<{ statusCode: number, body: Object }>}
 */
function makeHandler ({ tokenStore, platformDB }) {
  if (tokenStore == null) throw new Error('ackHandler: tokenStore is required');
  if (platformDB == null) throw new Error('ackHandler: platformDB is required');

  return async function handle (req) {
    const body = req && req.body ? req.body : {};
    const consumerIp = req && req.ip ? req.ip : null;

    const coreId = typeof body.coreId === 'string' ? body.coreId : null;
    const token = typeof body.token === 'string' ? body.token : null;
    if (!coreId || !token) {
      return errResponse(400, 'invalid-body', 'coreId and token are required');
    }

    const verdict = tokenStore.consume(token, { consumerIp });
    if (!verdict.ok) {
      // Map TokenStore reasons to a single 401 — we deliberately don't tell
      // the caller *why* the token failed (no oracle for guessing).
      const reason = VALID_REASONS.has(verdict.reason) ? verdict.reason : 'invalid';
      return errResponse(401, 'token-invalid', 'token rejected', { reason });
    }
    if (verdict.coreId !== coreId) {
      // Token was minted for a different core. Defensive — should never
      // happen unless the operator hand-edited the bundle.
      return errResponse(401, 'token-coreid-mismatch', 'token does not belong to this coreId');
    }

    const existing = await platformDB.getCoreInfo(coreId);
    if (existing == null) {
      return errResponse(404, 'core-not-pre-registered',
        `no PlatformDB row for ${coreId}; the bootstrap CLI must run on the issuing core first`);
    }

    const updated = { ...existing, available: true };
    await platformDB.setCoreInfo(coreId, updated);

    const allCores = typeof platformDB.getAllCoreInfos === 'function'
      ? await platformDB.getAllCoreInfos()
      : [updated];
    const lscDns = typeof platformDB.getDnsRecord === 'function'
      ? await platformDB.getDnsRecord('lsc')
      : null;

    return {
      statusCode: 200,
      body: {
        ok: true,
        coreId,
        cluster: {
          cores: allCores.map(c => ({
            id: c.id,
            url: c.url ?? null,
            hosting: c.hosting ?? null,
            available: c.available !== false
          })),
          lscIps: (lscDns && Array.isArray(lscDns.a)) ? lscDns.a : []
        }
      }
    };
  };
}

function errResponse (statusCode, id, message, extra = {}) {
  return {
    statusCode,
    body: { error: { id, message, ...extra } }
  };
}

module.exports = { makeHandler };
