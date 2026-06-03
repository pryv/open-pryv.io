/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
import type { Request, Response, Application as ExpressApp } from 'express';

type AppLike = { config: { get: (key: string) => unknown } };

/**
 * GET /apps — list applications linked to this service.
 * GET /apps/:appid — specific application metadata.
 * Config-based: reads from config 'appList'.
 */

export default function (expressApp: ExpressApp, app: AppLike) {
  const appsList = (app.config.get('appList') || {}) as Record<string, Record<string, unknown>>;

  expressApp.get('/apps', (req: Request, res: Response) => {
    const data = Object.entries(appsList).map(([id, info]) => ({ id, ...info }));
    res.json({ apps: data });
  });

  expressApp.get('/apps/:appid', (req: Request, res: Response) => {
    const appid = req.params.appid as string;
    const info = appsList[appid];
    if (!info) {
      return res.status(404).json({
        error: { id: 'unknown-resource', message: 'Unknown app: ' + appid }
      });
    }
    res.json({ app: { id: appid, ...info } });
  });
};
