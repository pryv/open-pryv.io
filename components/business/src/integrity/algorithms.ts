/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/**
 * Hash algorithms accepted for `integrity.algorithm`. The values computed
 * with it are unkeyed checksums of events, accesses and attachments: they
 * detect corruption, not a change made by someone who can write the storage
 * (who can recompute them). md5 and sha1 are no longer accepted. An
 * attachment checksum stored with one of them is still served as such (the
 * `Digest` header); events and accesses are checked against the configured
 * algorithm, so items written under another one no longer match it.
 */
const INTEGRITY_ALGORITHMS: readonly string[] = Object.freeze(['sha256', 'sha512']);

/** Why `algorithm` cannot be used for `integrity.algorithm`, or null when it can. */
function integrityAlgorithmProblem (algorithm: unknown): string | null {
  if (typeof algorithm === 'string' && INTEGRITY_ALGORITHMS.includes(algorithm)) return null;
  const shown = typeof algorithm === 'string' ? `'${algorithm}'` : String(algorithm);
  const weak = algorithm === 'md5' || algorithm === 'sha1' ? ' (no longer accepted: a weak hash)' : '';
  return `integrity.algorithm ${shown} is not supported${weak}: use one of ${INTEGRITY_ALGORITHMS.join(', ')} for the checksums of events, accesses and attachments`;
}

export { INTEGRITY_ALGORITHMS, integrityAlgorithmProblem };
