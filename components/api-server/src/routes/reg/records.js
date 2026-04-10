/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/**
 * POST /reg/records — admin endpoint for updating runtime DNS entries.
 *
 * Plan 27 Phase 1: records are persisted to PlatformDB (rqlite-replicated)
 * so they survive master restart and propagate to all cores in a multi-core
 * deployment. The IPC to the master process is kept as a fast-path signal so
 * the local DnsServer refreshes immediately — remote cores pick up the change
 * on their next periodic refresh.
 *
 * Auth: `auth:adminAccessKey` (BOOTSTRAP, must be identical across cores — see
 * `_plans/27-pre-open-pryv-merge-atwork/CONFIG-SEPARATION.md`).
 */

const { getPlatform } = require('platform');

module.exports = function (expressApp, app) {
  const adminAccessKey = app.config.get('auth:adminAccessKey');

  expressApp.post('/reg/records', async (req, res) => {
    // Admin auth check
    const secret = req.headers.authorization;
    if (secret == null || secret !== adminAccessKey) {
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

    // Persist to PlatformDB first — source of truth for runtime records.
    try {
      const platform = await getPlatform();
      await platform.setDnsRecord(subdomain, records);
    } catch (err) {
      return res.status(500).json({
        error: { id: 'unexpected', message: 'Failed to persist DNS record: ' + err.message }
      });
    }

    // Fast-path: nudge master so the local DnsServer refreshes immediately
    // instead of waiting for its periodic refresh interval.
    if (typeof process.send === 'function') {
      process.send({ type: 'dns:updateRecords', data: { subdomain } });
    }

    res.status(200).json({ subdomain, records, status: 'ok' });
  });
};
