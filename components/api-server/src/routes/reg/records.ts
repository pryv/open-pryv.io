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

    // Express 4 does not observe a rejected async handler: every step that
    // may throw stays inside a try, so a failure answers instead of hanging.
    let subdomain = '';
    let records: object = {};
    try {
      const body: unknown = req.body;
      if (body == null || typeof body !== 'object' || Array.isArray(body)) {
        return res.status(400).json({
          error: { id: 'invalid-parameters', message: 'The body must be an object' }
        });
      }
      const given = body as { subdomain?: unknown; records?: unknown };
      if (!given.subdomain || typeof given.subdomain !== 'string') {
        return res.status(400).json({
          error: { id: 'invalid-parameters', message: 'Missing or invalid subdomain' }
        });
      }
      if (!given.records || typeof given.records !== 'object') {
        return res.status(400).json({
          error: { id: 'invalid-parameters', message: 'Missing or invalid records' }
        });
      }
      subdomain = given.subdomain;
      records = given.records;
      const problems = validateDnsRecord(subdomain, records);
      if (problems.length > 0) {
        return res.status(400).json({
          error: { id: 'invalid-parameters', message: 'Invalid DNS record: ' + problems[0] }
        });
      }
    } catch (err) {
      return next(err);
    }

    try {
      const platform = await getPlatform();
      // A new name an account holds would take that account's host (DNS
      // records answer before usernames); an existing record may change.
      if (await platform.getDnsRecord(subdomain) == null && await platform.isNameHeldByAccount(subdomain)) {
        return res.status(409).json({
          error: { id: 'item-already-exists', message: `An account holds the name '${subdomain}': a record under it would take that account's host` }
        });
      }
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
