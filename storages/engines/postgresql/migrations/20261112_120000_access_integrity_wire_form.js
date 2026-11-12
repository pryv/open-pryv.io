/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
'use strict';

/**
 * Access integrity: the hash now covers the access as the API returns it
 * (composite `id` / `modifiedBy`, no internal serial fields). Accesses never
 * updated hash the same in both forms; the rows that differ (updated
 * accesses, their history rows and deletion records) get their `integrity`
 * recomputed here, once, when their stored value is the previous row hash.
 *
 * Idempotent: a row already in the new form is left as is. Safe to re-run.
 */
module.exports = {
  async up (context) {
    const { AccessesPG } = require('../src/user/AccessesPG.ts');
    const integrity = require('business/src/integrity/index.ts').default;
    const accesses = new AccessesPG(context.db, integrity.accesses);
    const res = await accesses.recomputeIntegrityOfVersionedRows();
    context.logger?.info?.('access integrity: ' + res.rewritten + ' of ' + res.scanned + ' versioned rows rewritten');
    return res;
  }
};
