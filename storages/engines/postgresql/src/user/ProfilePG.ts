/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

import { createRequire } from 'node:module';
import type { PgDbLike } from './BaseStoragePG.ts';
const require = createRequire(import.meta.url);

const { BaseStoragePG } = require('./BaseStoragePG.ts') as typeof import('./BaseStoragePG.ts');

/**
 * PostgreSQL persistence for profile sets. Profile documents are free-form
 * key/value sets — the base's default `StoredItem` binding is the honest type.
 */
class ProfilePG extends BaseStoragePG {
  constructor (db: PgDbLike) {
    super(db);
    this.tableName = 'profile';
    this.hasDeletedCol = false;
    this.hasHeadIdCol = false;
  }

  /**
   * Number of accounts on this core with an active SMS MFA enrolment: a
   * private profile `mfa` whose `method` is `sms` or absent (the legacy shape)
   * and whose `content` is not empty (what the MFA profile model reads as
   * active). One query across users, used by a boot-time check.
   */
  async countSmsMfaEnrolments (): Promise<number> {
    const res = await this.db.query(
      `SELECT count(*)::int AS n FROM profile
        WHERE id = 'private'
          AND jsonb_typeof(data->'mfa') = 'object'
          AND COALESCE(data->'mfa'->>'method', 'sms') = 'sms'
          AND jsonb_typeof(data->'mfa'->'content') = 'object'
          AND data->'mfa'->'content' <> '{}'::jsonb`
    );
    return Number(res.rows[0]?.n ?? 0);
  }
}

export { ProfilePG };