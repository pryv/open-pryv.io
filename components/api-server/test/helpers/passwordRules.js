/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/**
 * Helpers for testing password rules.
 */
module.exports = {
  settingsOverride: {
    auth: {
      passwordComplexityMinCharCategories: 3,
      passwordComplexityMinLength: 8,
      passwordAgeMaxDays: 365,
      passwordAgeMinDays: 0,
      passwordPreventReuseHistoryLength: 3
    }
  },

  passwords: {
    good3CharCats: '1L0v3T0p', // 8 chars long == min length
    good4CharCats: '1.L0v3.T0p1n4mb0urz',
    bad2CharCats: '1l0v3c0urg3tt3z', // missing caps & special chars
    badTooShort: '1L0v3U!' // 7 chars vs 8 minimum
  }
};
