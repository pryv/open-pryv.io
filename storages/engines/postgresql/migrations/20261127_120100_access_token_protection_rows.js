/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
'use strict';

/**
 * Access tokens and session ids at rest, step 2: every access row holding a
 * clear token (live, deleted, history) and every session keyed by its clear
 * id are converted in place to the keyed hash plus encrypted copy. The public
 * `integrity` value is unchanged: it is computed on the item, the same before
 * and after. Tokens and sessions only (`tokensOnly`): sealing the integrity,
 * the deletion notices and dropping the token of deleted accesses are step 5
 * (`20261127_120400`), after its indexes.
 *
 * The same pass runs at every start (see `protectTokensAtRest`), so rows a
 * previous image wrote after a rollback are converted too. Idempotent.
 */
module.exports = {
  async up (context) {
    const { protectTokensAtRest } = require('../src/tokensAtRest.ts');
    const res = await protectTokensAtRest(context.db, { tokensOnly: true });
    context.logger?.info?.('access tokens at rest: ' + res.accesses + ' access rows and ' + res.sessions +
      ' sessions protected, ' + res.sessionsExpired + ' expired sessions removed');
    return res;
  }
};
