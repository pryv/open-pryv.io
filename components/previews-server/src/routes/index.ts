/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

import type { Request, Response, Application as ExpressApp } from 'express';

export default function index (expressApp: ExpressApp) {
  expressApp.options('*', function (req: Request, res: Response /*, next */) {
    // common headers (e.g. CORS) are handled in related middleware
    res.sendStatus(200);
  });
};
