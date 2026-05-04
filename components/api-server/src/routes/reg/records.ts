/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
import type {} from 'node:fs';


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
 */

const { getPlatform } = require('platform');

module.exports = function (expressApp, app) {
  const adminAccessKey = app.config.get('auth:adminAccessKey');

  function isAuthorized (req) {
    const secret = req.headers.authorization;
    return secret != null && secret === adminAccessKey;
  }

  function nudgeMaster (subdomain) {
    if (typeof process.send === 'function') {
      process.send({ type: 'dns:updateRecords', data: { subdomain } });
    }
  }

  expressApp.post('/reg/records', async (req, res) => {
    if (!isAuthorized(req)) {
      return res.status(403).json({
        error: { id: 'forbidden', message: 'Invalid admin authorization' }
      });
    }

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

    try {
      const platform = await getPlatform();
      await platform.setDnsRecord(subdomain, records);
    } catch (err) {
      return res.status(500).json({
        error: { id: 'unexpected', message: 'Failed to persist DNS record: ' + err.message }
      });
    }

    nudgeMaster(subdomain);
    res.status(200).json({ subdomain, records, status: 'ok' });
  });

  expressApp.delete('/reg/records/:subdomain', async (req, res) => {
    if (!isAuthorized(req)) {
      return res.status(403).json({
        error: { id: 'forbidden', message: 'Invalid admin authorization' }
      });
    }

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
      return res.status(500).json({
        error: { id: 'unexpected', message: 'Failed to delete DNS record: ' + err.message }
      });
    }

    nudgeMaster(subdomain);
    res.status(200).json({ subdomain, status: 'deleted' });
  });
};
