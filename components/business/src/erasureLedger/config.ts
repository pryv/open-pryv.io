/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/**
 * `accountErasure.ledger`: the durable record that an account was erased (see
 * `./index.ts`). Platform-wide block: set the same values on every core.
 *
 * `erasureLedgerConfig` fills the defaults and never throws (it runs on the
 * erasure path); `describeErasureLedgerConfig` is the boot-time check.
 */

type Problem = { message: string; path: string[] };
type Raw = Record<string, unknown>;

export type ErasureLedgerConfig = {
  enabled: boolean;
  /** Days a record is kept after the erasure; 0 = kept forever. */
  retentionDays: number;
  /** base64 of 32 bytes, or null: derived from `auth.adminAccessKey`. */
  hmacKey: string | null;
};

export const DEFAULT_RETENTION_DAYS = 1825;
/** Below this (and above 0), a retention gets a warning: shorter than most backup retentions. */
export const RETENTION_WARN_DAYS = 365;
export const LEDGER_KEY_BYTES = 32;

const BASE_PATH = ['accountErasure', 'ledger'];

const obj = (v: unknown): Raw => (v != null && typeof v === 'object' && !Array.isArray(v)) ? v as Raw : {};
const isNonNegInt = (v: unknown): v is number => Number.isInteger(v) && (v as number) >= 0;

/** The bytes of an explicit ledger key, or null when the value is not base64 of 32 bytes. */
export function explicitKeyBytes (value: unknown): Buffer | null {
  if (typeof value !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(value.trim())) return null;
  const bytes = Buffer.from(value.trim(), 'base64');
  return bytes.length === LEDGER_KEY_BYTES ? bytes : null;
}

/** The ledger settings, defaults filled in; a malformed value reads as its default. */
export function erasureLedgerConfig (config: { get (key: string): unknown }): ErasureLedgerConfig {
  let raw: Raw = {};
  try { raw = obj(config.get('accountErasure:ledger')); } catch { raw = {}; }
  const hmacKey = typeof raw.hmacKey === 'string' && raw.hmacKey.trim() !== '' ? raw.hmacKey.trim() : null;
  return {
    enabled: raw.enabled !== false,
    retentionDays: isNonNegInt(raw.retentionDays) ? raw.retentionDays : DEFAULT_RETENTION_DAYS,
    hmacKey
  };
}

/**
 * Boot-time check of the `accountErasure.ledger` block:
 *  - `problems`: values that cannot work; the boot is refused.
 *  - `warnings`: values that work but defeat part of the purpose; logged.
 */
export function describeErasureLedgerConfig (rawBlock: unknown): { problems: Problem[]; warnings: string[] } {
  const problems: Problem[] = [];
  const warnings: string[] = [];
  if (rawBlock == null) return { problems, warnings };
  if (typeof rawBlock !== 'object' || Array.isArray(rawBlock)) {
    problems.push({ message: 'must be a map of settings.', path: BASE_PATH });
    return { problems, warnings };
  }
  const raw = rawBlock as Raw;
  const bad = (key: string, message: string) => problems.push({ message, path: [...BASE_PATH, key] });
  if (raw.enabled !== undefined && typeof raw.enabled !== 'boolean') bad('enabled', 'must be true or false.');
  if (raw.retentionDays !== undefined && !isNonNegInt(raw.retentionDays)) {
    bad('retentionDays', 'must be a whole number of days >= 0 (0 keeps the records forever).');
  }
  if (raw.hmacKey != null && raw.hmacKey !== '' && explicitKeyBytes(raw.hmacKey) == null) {
    bad('hmacKey', `must be base64 of ${LEDGER_KEY_BYTES} random bytes (e.g. \`openssl rand -base64 32\`), the same on every core, or empty (derived from auth.adminAccessKey).`);
  }
  if (raw.enabled === false) {
    warnings.push('accountErasure.ledger.enabled is false: account erasures leave no durable record, so an erasure cannot be proven later ' +
      'nor replayed after a restore of the storage.');
  }
  if (isNonNegInt(raw.retentionDays) && raw.retentionDays > 0 && raw.retentionDays < RETENTION_WARN_DAYS) {
    warnings.push(`accountErasure.ledger.retentionDays is ${raw.retentionDays}: shorter than a year. Keep the records at least as long ` +
      'as your longest backup retention, or a restore of an older backup can bring back an erased account unnoticed.');
  }
  return { problems, warnings };
}
