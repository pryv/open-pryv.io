/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
import type {} from 'node:fs';


/**
 * GET /apps — list applications linked to this service.
 * GET /apps/:appid — specific application metadata.
 * Config-based: reads from config 'appList'.
 */

export default function (expressApp: any, app: any) {
  const appsList = app.config.get('appList') || {};

  expressApp.get('/apps', (req: any, res: any) => {
    const data = (Object.entries(appsList) as Array<[string, any]>).map(([id, info]) => ({ id, ...info }));
    res.json({ apps: data });
  });

  expressApp.get('/apps/:appid', (req: any, res: any) => {
    const appid = req.params.appid;
    const info = appsList[appid];
    if (!info) {
      return res.status(404).json({
        error: { id: 'unknown-resource', message: 'Unknown app: ' + appid }
      });
    }
    res.json({ app: { id: appid, ...info } });
  });
};
