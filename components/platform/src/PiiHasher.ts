/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/**
 * Deterministic HMAC-SHA-256 of PII values destined for PlatformDB.
 *
 * Problem: PlatformDB is replicated cluster-wide via rqlite Raft. In a
 * multi-region cluster, every row crosses every jurisdiction. Today those
 * rows carry plaintext usernames + `isUnique`-system-stream values (the
 * default `isUnique` field is email), so PII leaves the user's home region
 * as a side effect of the routing/uniqueness index.
 *
 * Mitigation: when operator opts into `platform.piiMode: hashed`, callers
 * derive an opaque HMAC token from every PII value before writing or
 * querying. The keyed hash is deterministic (same plaintext + same pepper
 * → same token) so equality lookups still work; the inverse is infeasible
 * without the cluster pepper.
 *
 * Wiring (Plan 99 B.1 — primitive only; callers thread through in B.2):
 *   - Pepper: 32 bytes, base64, distributed via bootstrap bundle to every
 *     core, persisted in each core's override-config.yml as
 *     `platform.piiHmacKey` — operator-sync responsibility, same shape as
 *     `letsEncrypt.atRestKey`.
 *   - Cross-field collisions are avoided by mixing the field name into the
 *     HMAC input: `HMAC(pepper, field || "\0" || normalize(value))`. Two
 *     `isUnique` fields holding the same value (e.g. `username = alice` +
 *     a custom field also storing `alice`) yield distinct tokens.
 *   - Normalisation (lowercase + trim) is applied to `email`-shaped fields
 *     so `User@x.com` and `user@x.com` still collide. Other fields are
 *     trimmed only — case-sensitive equality is preserved.
 *
 * Hashing is pseudonymisation (EDPB / WP29 Opinion 05/2014), NOT
 * anonymisation: input domains (usernames, emails) are low-entropy enough
 * for brute-force re-identification by reasonable means. Recital 26 keeps
 * such data in GDPR scope. An Art.46 mechanism (SCCs / BCRs) is still
 * required for cross-border replication of HMAC'd PII; what this primitive
 * achieves is the defence-in-depth + Art.32(1)(a) pseudonymisation evidence.
 */

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const crypto = require('node:crypto');

const PEPPER_BYTES = 32;

/**
 * Fields whose values are normalised to lowercase (and trimmed) before
 * hashing. Anything not in this set is only trimmed — case is preserved.
 *
 * Email is the canonical isUnique system-stream field. Custom operator
 * deployments may add other case-insensitive fields here — but the entry
 * MUST agree across every core in the cluster, otherwise the same logical
 * value would hash to different tokens depending on which core processed
 * the write.
 */
const CASE_INSENSITIVE_FIELDS = new Set<string>(['email']);

class PiiHasher {
  #pepper: Buffer;

  /**
   * @param pepperBase64 - base64 of exactly 32 random bytes. Generate with
   *   `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`.
   *   Same shape + ops responsibility as `letsEncrypt.atRestKey`.
   */
  constructor (pepperBase64: string) {
    if (typeof pepperBase64 !== 'string' || pepperBase64.length === 0) {
      throw new Error('PiiHasher: pepperBase64 is required (32 random bytes, base64-encoded)');
    }
    let buf: Buffer;
    try {
      buf = Buffer.from(pepperBase64, 'base64');
    } catch {
      throw new Error('PiiHasher: pepperBase64 is not valid base64');
    }
    if (buf.length !== PEPPER_BYTES) {
      throw new Error(`PiiHasher: pepper must decode to exactly ${PEPPER_BYTES} bytes, got ${buf.length}`);
    }
    this.#pepper = buf;
  }

  /**
   * Normalise + HMAC a PII value. Returns the lowercase hex digest.
   *
   * `field` is mixed into the HMAC input so the same value stored under
   * two different field names hashes to distinct tokens — avoids cross-
   * field collisions on the rqlite `keyValue` index.
   *
   * @param field - PlatformDB field name (e.g. 'username', 'email', or a
   *   custom isUnique system-stream field).
   * @param plaintext - the user-supplied value, exactly as it would have
   *   been stored in cleartext mode.
   */
  hashFor (field: string, plaintext: string): string {
    if (typeof field !== 'string' || field.length === 0) {
      throw new Error('PiiHasher.hashFor: field is required');
    }
    if (typeof plaintext !== 'string') {
      throw new Error('PiiHasher.hashFor: plaintext must be a string');
    }
    const normalized = PiiHasher.normalize(field, plaintext);
    const hmac = crypto.createHmac('sha256', this.#pepper);
    hmac.update(field, 'utf8');
    hmac.update(Buffer.from([0]));
    hmac.update(normalized, 'utf8');
    return hmac.digest('hex');
  }

  /**
   * Apply the same normalisation `hashFor()` does, without hashing. Useful
   * for callers that need to compare a normalised plaintext against another
   * normalised plaintext in `cleartext` mode while staying byte-identical
   * to what `hashed` mode would have produced.
   */
  static normalize (field: string, value: string): string {
    const trimmed = value.trim();
    if (CASE_INSENSITIVE_FIELDS.has(field)) {
      return trimmed.toLowerCase();
    }
    return trimmed;
  }
}

export default PiiHasher;
export { PiiHasher, PEPPER_BYTES, CASE_INSENSITIVE_FIELDS };
