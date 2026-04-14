/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/**
 * Plan 34 — PlatformDB + DNS side-effects for the bootstrap CLI.
 *
 * When the CLI on an existing core issues a bundle for a new core, it also
 * pre-registers the new core in PlatformDB and publishes the DNS entries
 * rqlite peer discovery and client routing need. This happens *before* the
 * bundle is handed to the operator, so by the time the new core boots:
 *
 *  - `/reg/cores?username=…` and `/reg/hostings` already know about it
 *    (as `available:false` until the ack endpoint flips it on).
 *  - `lsc.{domain}` already lists its IP (so rqlited peer discovery works
 *    as soon as it starts up).
 *  - `{core-id}.{domain}` already resolves to its IP.
 *
 * The only non-trivial mutation is `lsc.{domain}`: Plan 31's API replaces
 * records per-subdomain. We want *append* semantics (the record must list
 * every core's IP), so we read-merge-write. Two concurrent bootstrap runs
 * could race on this path; the CLI surfaces a warning reminding operators
 * that adding a core is a deliberate single-operator action.
 */

const LSC_SUBDOMAIN = 'lsc';

/**
 * Pre-register a new core in PlatformDB and publish its DNS entries.
 * Idempotent: re-running with the same inputs leaves the state unchanged.
 *
 * @param {Object} opts
 * @param {Object} opts.platformDB - object exposing setCoreInfo / getDnsRecord / setDnsRecord (PlatformDB.js interface)
 * @param {string} opts.coreId     - e.g. 'core-b'
 * @param {string} opts.ip         - the new core's IP address (IPv4 or IPv6)
 * @param {string|null} [opts.url=null]     - explicit core.url (DNSless multi-core); optional
 * @param {string|null} [opts.hosting=null] - hosting region, e.g. 'us-east-1'
 * @returns {Promise<{ coreInfo: Object, perCoreAAdded: boolean, lscIpsAfter: string[] }>}
 */
async function registerNewCore ({ platformDB, coreId, ip, url = null, hosting = null }) {
  requireInput({ platformDB, coreId, ip });

  const coreInfo = {
    id: coreId,
    ip,
    url,
    hosting,
    available: false
  };
  await platformDB.setCoreInfo(coreId, coreInfo);

  // Per-core A record ({core-id}.{domain} → ip). Idempotent: setDnsRecord
  // is last-writer-wins per subdomain.
  const existingPerCore = await platformDB.getDnsRecord(coreId);
  const targetPerCore = { a: [ip] };
  let perCoreAAdded = true;
  if (existingPerCore != null && arraysEqual(existingPerCore.a, targetPerCore.a)) {
    perCoreAAdded = false; // nothing to write
  } else {
    await platformDB.setDnsRecord(coreId, targetPerCore);
  }

  // lsc.{domain} — append semantics. Read, merge, write.
  const lscBefore = await platformDB.getDnsRecord(LSC_SUBDOMAIN);
  const lscIpsBefore = (lscBefore && Array.isArray(lscBefore.a)) ? lscBefore.a : [];
  const lscIpsAfter = lscIpsBefore.includes(ip) ? lscIpsBefore : [...lscIpsBefore, ip];
  if (lscIpsAfter !== lscIpsBefore) {
    await platformDB.setDnsRecord(LSC_SUBDOMAIN, { ...(lscBefore || {}), a: lscIpsAfter });
  }

  return { coreInfo, perCoreAAdded, lscIpsAfter };
}

/**
 * Undo `registerNewCore`. Used by the revoke-token CLI path when the
 * operator decides not to actually deploy the core the bundle was issued
 * for. Intentionally does NOT touch other cores' entries in `lsc`.
 *
 * @param {Object} opts
 * @param {Object} opts.platformDB
 * @param {string} opts.coreId
 * @param {string} opts.ip
 * @returns {Promise<{ coreInfoDeleted: boolean, perCoreDeleted: boolean, lscIpsAfter: string[] }>}
 */
async function unregisterNewCore ({ platformDB, coreId, ip }) {
  requireInput({ platformDB, coreId, ip });

  // Only remove the core-info row if it still belongs to this coreId and
  // is not yet active. This protects against races where a different
  // bootstrap run has overwritten the slot.
  let coreInfoDeleted = false;
  const existing = await platformDB.getCoreInfo(coreId);
  if (existing != null && existing.available === false) {
    if (typeof platformDB.deleteCoreInfo === 'function') {
      await platformDB.deleteCoreInfo(coreId);
    } else {
      // Fallback: mark it unavailable and leave the row in place.
      // Older PlatformDB implementations may not expose deleteCoreInfo.
      await platformDB.setCoreInfo(coreId, { ...existing, available: false });
    }
    coreInfoDeleted = true;
  }

  // Per-core A record: drop it only if it still points at this ip.
  let perCoreDeleted = false;
  const perCore = await platformDB.getDnsRecord(coreId);
  if (perCore != null && Array.isArray(perCore.a) && perCore.a.length === 1 && perCore.a[0] === ip) {
    await platformDB.deleteDnsRecord(coreId);
    perCoreDeleted = true;
  }

  // lsc.{domain} — remove ip from the list. Leave the record in place
  // (other cores may still be listed).
  const lsc = await platformDB.getDnsRecord(LSC_SUBDOMAIN);
  const lscIpsBefore = (lsc && Array.isArray(lsc.a)) ? lsc.a : [];
  const lscIpsAfter = lscIpsBefore.filter(x => x !== ip);
  if (lscIpsAfter.length !== lscIpsBefore.length) {
    if (lscIpsAfter.length === 0) {
      await platformDB.deleteDnsRecord(LSC_SUBDOMAIN);
    } else {
      await platformDB.setDnsRecord(LSC_SUBDOMAIN, { ...lsc, a: lscIpsAfter });
    }
  }

  return { coreInfoDeleted, perCoreDeleted, lscIpsAfter };
}

function requireInput ({ platformDB, coreId, ip }) {
  if (platformDB == null) throw new Error('DnsRegistration: platformDB is required');
  if (!coreId) throw new Error('DnsRegistration: coreId is required');
  if (!ip) throw new Error('DnsRegistration: ip is required');
}

function arraysEqual (a, b) {
  if (!Array.isArray(a) || !Array.isArray(b)) return false;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

module.exports = {
  registerNewCore,
  unregisterNewCore
};
