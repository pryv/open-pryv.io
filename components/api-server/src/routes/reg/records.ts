/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
import { createRequire } from 'node:module';
import type { AppLike, PryvRequest } from '../_types.ts';
import type { Request, Response, NextFunction, Application as ExpressApp } from 'express';
const require = createRequire(import.meta.url);
/**
 * /reg/records — admin endpoints for managing runtime DNS entries.
 *
 * POST   /reg/records            upsert a record (body: { subdomain, records })
 * DELETE /reg/records/:subdomain remove a record
 *
 * Records are persisted to PlatformDB (rqlite-replicated) so they survive
 * master restart and propagate to all cores in a multi-core deployment. The
 * IPC to the master process is a fast-path signal so the local DnsServer
 * refreshes immediately — remote cores pick up the change on their next
 * periodic refresh.
 *
 * Auth: `auth:adminAccessKey` (BOOTSTRAP, must be identical across cores).
 * A missing or wrong key answers 404, like the other admin routes.
 */

const { getPlatform } = require('platform');
const { validateDnsRecord } = require('dns-server/src/recordValidation.ts');
const errors = require('errors').factory;
const isAdminKey = require('middleware/src/isAdminKey.ts').default;
const { clientIp } = require('middleware/src/clientIp.ts');
const { redactUrl } = require('utils/src/redactUrl.ts');
const { getLogger } = require('@pryv/boiler');

const logger = getLogger('routes:reg:records');


export default function (expressApp: ExpressApp, app: AppLike) {
  const adminAccessKey = app.config.get('auth:adminAccessKey') as string | undefined;

  function isAuthorized (req: Request): boolean {
    if (isAdminKey(req.headers.authorization, adminAccessKey)) return true;
    // Never the headers: a near-miss key would land in the log.
    logger.warn('Unauthorized attempt to access an admin route', { url: redactUrl(req.url), ip: clientIp(req) });
    return false;
  }

  function nudgeMaster (subdomain: string): void {
    if (typeof process.send === 'function') {
      process.send({ type: 'dns:updateRecords', data: { subdomain } });
    }
  }

  expressApp.post('/reg/records', async (req: Request, res: Response, next: NextFunction) => {
    if (!isAuthorized(req)) return next(errors.unknownResource());

    const { subdomain, records } = req.body;
    if (!subdomain || typeof subdomain !== 'string') {
      return res.status(400).json({
        error: { id: 'invalid-parameters', message: 'Missing or invalid subdomain' }
      });
    }
    if (!records || typeof records !== 'object') {
      return res.status(400).json({
        error: { id: 'invalid-parameters', message: 'Missing or invalid records' }
      });
    }
    const problems = validateDnsRecord(subdomain, records);
    if (problems.length > 0) {
      return res.status(400).json({
        error: { id: 'invalid-parameters', message: 'Invalid DNS record: ' + problems[0] }
      });
    }

    try {
      const platform = await getPlatform();
      await platform.setDnsRecord(subdomain, records);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return res.status(500).json({
        error: { id: 'unexpected', message: 'Failed to persist DNS record: ' + message }
      });
    }

    nudgeMaster(subdomain);
    res.status(200).json({ subdomain, records, status: 'ok' });
  });

  expressApp.delete('/reg/records/:subdomain', async (req: Request, res: Response, next: NextFunction) => {
    if (!isAuthorized(req)) return next(errors.unknownResource());

    const { subdomain } = req.params;
    if (!subdomain || typeof subdomain !== 'string') {
      return res.status(400).json({
        error: { id: 'invalid-parameters', message: 'Missing or invalid subdomain' }
      });
    }

    try {
      const platform = await getPlatform();
      const existing = await platform.getDnsRecord(subdomain);
      if (existing == null) {
        return res.status(404).json({
          error: { id: 'unknown-resource', message: `No DNS record for subdomain '${subdomain}'` }
        });
      }
      await platform.deleteDnsRecord(subdomain);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return res.status(500).json({
        error: { id: 'unexpected', message: 'Failed to delete DNS record: ' + message }
      });
    }

    nudgeMaster(subdomain);
    res.status(200).json({ subdomain, status: 'deleted' });
  });
};
