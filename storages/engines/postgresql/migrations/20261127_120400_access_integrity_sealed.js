/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
'use strict';

/**
 * Access tokens at rest, step 5: the stored access `integrity` (an unkeyed
 * hash of the access, its token included) is sealed in its column like the
 * token's encrypted copy; the pending deletion notices' endpoints are sealed;
 * deleted accesses and the history rows of deleted accesses drop their
 * token, their integrity re-hashed without it.
 *
 * Two indexes keep the checks of every start from reading the whole table:
 * the rows whose integrity is still in clear (empty in steady state) and the
 * key id of the sealed values (`sealed:` plus 8 characters of key id and the
 * dot: 16 characters). The expressions must stay the ones the probes of
 * `AccessesPG` use. Then the conversion pass, which the start runs too.
 *
 * Idempotent.
 */
module.exports = {
  async up (context) {
    await context.db.query(`
      CREATE INDEX IF NOT EXISTS idx_access_integrity_clear
        ON accesses(user_id) WHERE integrity IS NOT NULL AND integrity NOT LIKE 'sealed:%';
      CREATE INDEX IF NOT EXISTS idx_access_integrity_kid
        ON accesses ((left(integrity, 16))) WHERE integrity LIKE 'sealed:%';
    `);
    const { protectTokensAtRest } = require('../src/tokensAtRest.ts');
    const res = await protectTokensAtRest(context.db, { deletedTokens: true });
    context.logger?.info?.('access integrity at rest: ' + res.integrity + ' access rows sealed, ' + res.deletedTokens +
      ' deleted access rows without their token, ' + res.deletionNotices + ' deletion notices sealed');
    return res;
  }
};
