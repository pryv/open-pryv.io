/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
import type {} from 'node:fs';


/**
 * POST /system/admin/cores/ack handler.
 *
 * Called by a freshly bootstrapped core to confirm it has joined. The
 * one-time join token from the bundle authenticates the call. Every check
 * runs before the token is burned: token valid, token minted for this
 * coreId, core pre-registered, node certificate fingerprint equal to the
 * one recorded at issuance. Only then is the token consumed, the core's
 * `available` bit flipped to true and a cluster snapshot returned.
 *
 * Every refusal gets the same 401 body; the reason goes to `log` only.
 *
 * The handler is decoupled from Express so it can be unit-tested with a
 * fake `platformDB` and an in-memory `tokenStore`. The route wiring in
 * `routes/system.js` is a thin adapter over this function.
 *
 * Possible return.statusCode values:
 *   200 — token verified, core marked available
 *   400 — malformed body (missing coreId/token)
 *   401 — refused (reason logged server-side)
 *   500 — internal failure (caller should re-raise / log)
 */

type CoreInfo = { id: string; url?: string | null; hosting?: string | null; available?: boolean; [k: string]: unknown };
type DnsRecord = { a?: string[]; [k: string]: unknown };
type TokenVerdict = { ok: true; coreId: string; certFingerprint?: string } | { ok: false; reason: string };
type TokenStoreLike = {
  verify: (token: string) => TokenVerdict;
  consume: (token: string, opts: { consumerIp: string | null }) => TokenVerdict;
};
type PlatformDBLike = {
  getCoreInfo: (coreId: string) => Promise<CoreInfo | null>;
  setCoreInfo: (coreId: string, info: CoreInfo) => Promise<unknown>;
  getAllCoreInfos?: () => Promise<CoreInfo[]>;
  getDnsRecord?: (subdomain: string) => Promise<DnsRecord | null>;
};
type AckRequest = { body?: { coreId?: unknown; token?: unknown; tlsFingerprint?: unknown }; ip?: string };
type AckResponse = { statusCode: number; body: Record<string, unknown> };

/**
 * @param deps.tokenStore - business/src/bootstrap/TokenStore instance
 * @param deps.platformDB - exposes getCoreInfo / setCoreInfo / getAllCoreInfos / getDnsRecord
 * @param [deps.log] - receives the reason of each refusal
 */
function makeHandler ({ tokenStore, platformDB, log = () => {} }: { tokenStore: TokenStoreLike; platformDB: PlatformDBLike; log?: (msg: string) => void }) {
  if (tokenStore == null) throw new Error('ackHandler: tokenStore is required');
  if (platformDB == null) throw new Error('ackHandler: platformDB is required');

  return async function handle (req: AckRequest): Promise<AckResponse> {
    const body = req && req.body ? req.body : {};
    const consumerIp = req && req.ip ? req.ip : null;

    const coreId = typeof body.coreId === 'string' ? body.coreId : null;
    const token = typeof body.token === 'string' ? body.token : null;
    if (!coreId || !token) {
      return errResponse(400, 'invalid-body', 'coreId and token are required');
    }
    const refuse = (reason: string): AckResponse => {
      log(`cores/ack refused for coreId ${JSON.stringify(coreId)} from ${consumerIp ?? 'unknown ip'}: ${reason}`);
      return errResponse(401, 'ack-refused', 'join acknowledgement refused');
    };

    const verdict: TokenVerdict = tokenStore.verify(token);
    if (!verdict.ok) return refuse('token ' + verdict.reason);
    if (verdict.coreId !== coreId) return refuse(`token was issued for coreId ${JSON.stringify(verdict.coreId)}`);

    const existing = await platformDB.getCoreInfo(coreId);
    if (existing == null) return refuse('no pre-registered core-info row (run new-core on the issuing core)');

    if (verdict.certFingerprint != null) {
      const presented = typeof body.tlsFingerprint === 'string' ? body.tlsFingerprint.toUpperCase() : null;
      if (presented !== verdict.certFingerprint.toUpperCase()) {
        return refuse('node certificate fingerprint differs from the one issued with the token');
      }
    }

    const consumed: TokenVerdict = tokenStore.consume(token, { consumerIp });
    if (!consumed.ok) return refuse('token ' + consumed.reason);

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
          cores: allCores.map((c: CoreInfo) => ({
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

function errResponse (statusCode: number, id: string, message: string): AckResponse {
  return {
    statusCode,
    body: { error: { id, message } }
  };
}

export { makeHandler };
