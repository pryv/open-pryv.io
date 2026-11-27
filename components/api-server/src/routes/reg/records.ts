/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
import { createRequire } from 'node:module';
import type { AppLike } from '../_types.ts';
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
 * Auth: `auth:adminAccessKey` (BOOTSTRAP, must be identical across cores),
 * refused under `auth.adminAccessKeyScope: break-glass`.
 * A missing or wrong key answers 404, like the other admin routes.
 */

const { getPlatform } = require('platform');
const { validateDnsRecord } = require('dns-server/src/recordValidation.ts');
const errors = require('errors').factory;
const { isAdminKeyInFullScope } = require('middleware/src/isAdminKey.ts');
const { isPlatformNoAnswer } = require('storages/interfaces/platformStorage/noAnswer.ts');
const { clientIp } = require('middleware/src/clientIp.ts');
const { redactUrl } = require('utils/src/redactUrl.ts');
const { getLogger } = require('@pryv/boiler');
const { adminKeyAct, adminRoute, setRouteAct } = require('../../methods/helpers/adminAudit.ts') as typeof import('../../methods/helpers/adminAudit.ts');

const logger = getLogger('routes:reg:records');

export default function (expressApp: ExpressApp, app: AppLike) {
  function isAuthorized (req: Request): boolean {
    if (isAdminKeyInFullScope(req.headers.authorization, app.config)) return true;
    // Never the headers: a near-miss key would land in the log.
    logger.warn('Unauthorized attempt to access an admin route', { url: redactUrl(req.url), ip: clientIp(req) });
    return false;
  }

  function nudgeMaster (subdomain: string): void {
    if (typeof process.send === 'function') {
      process.send({ type: 'dns:updateRecords', data: { subdomain } });
    }
  }

  // The username-rewriter skips the platform's names: re-read them so this
  // worker treats the changed record at once (the others within their
  // periodic refresh). The record is stored either way: a failed read is
  // only logged, the next refresh catches up.
  async function refreshPlatformNames (platform: { refreshPlatformNames: () => Promise<void> }): Promise<void> {
    try {
      await platform.refreshPlatformNames();
    } catch (err) {
      logger.warn('could not re-read the platform names after a DNS record change: ' + (err instanceof Error ? err.message : String(err)));
    }
  }

  // An authorized write is an administration act: recorded in the platform trail, done or refused.
  expressApp.post('/reg/records', adminKeyAct('system.reg.records.set', app.config), adminRoute(), async (req: Request, res: Response, next: NextFunction) => {
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
      // The name and the kinds of record, not their values.
      setRouteAct(res, { target: { subdomain: subdomain.slice(0, 256) }, diff: { recordTypes: Object.keys(records).slice(0, 20) } });
      const problems = validateDnsRecord(subdomain, records);
      if (problems.length > 0) {
        return res.status(400).json({
          error: { id: 'invalid-parameters', message: 'Invalid DNS record: ' + problems[0] }
        });
      }
    } catch (err) {
      return next(err);
    }

    let platform;
    try {
      platform = await getPlatform();
      // A new name an account holds would take that account's host (DNS
      // records answer before usernames); an existing record may change.
      if (await platform.getDnsRecord(subdomain) == null && await platform.isNameHeldByAccount(subdomain)) {
        return res.status(409).json({
          error: { id: 'item-already-exists', message: `An account holds the name '${subdomain}': a record under it would take that account's host` }
        });
      }
      await platform.setDnsRecord(subdomain, records);
    } catch (err) {
      // The platform database did not answer: 503 with Retry-After (error middleware).
      if (isPlatformNoAnswer(err)) return next(err);
      const message = err instanceof Error ? err.message : String(err);
      return res.status(500).json({
        error: { id: 'unexpected-error', message: 'Failed to persist DNS record: ' + message }
      });
    }

    await refreshPlatformNames(platform);
    nudgeMaster(subdomain);
    res.status(200).json({ subdomain, records, status: 'ok' });
  });

  expressApp.delete('/reg/records/:subdomain', adminKeyAct('system.reg.records.delete', app.config), adminRoute(), async (req: Request, res: Response, next: NextFunction) => {
    if (!isAuthorized(req)) return next(errors.unknownResource());

    const { subdomain } = req.params;
    if (!subdomain || typeof subdomain !== 'string') {
      return res.status(400).json({
        error: { id: 'invalid-parameters', message: 'Missing or invalid subdomain' }
      });
    }
    setRouteAct(res, { target: { subdomain: subdomain.slice(0, 256) } });

    let platform;
    try {
      platform = await getPlatform();
      const existing = await platform.getDnsRecord(subdomain);
      if (existing == null) {
        return res.status(404).json({
          error: { id: 'unknown-resource', message: `No DNS record for subdomain '${subdomain}'` }
        });
      }
      await platform.deleteDnsRecord(subdomain);
    } catch (err) {
      if (isPlatformNoAnswer(err)) return next(err);
      const message = err instanceof Error ? err.message : String(err);
      return res.status(500).json({
        error: { id: 'unexpected-error', message: 'Failed to delete DNS record: ' + message }
      });
    }

    await refreshPlatformNames(platform);
    nudgeMaster(subdomain);
    res.status(200).json({ subdomain, status: 'deleted' });
  });
}
