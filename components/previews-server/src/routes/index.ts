/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

import type {} from 'node:fs';

export default function index (expressApp: any) {
  expressApp.options('*', function (req: any, res: any /*, next */) {
    // common headers (e.g. CORS) are handled in related middleware
    res.sendStatus(200);
  });
};
