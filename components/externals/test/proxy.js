/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/**
 * HTTPS proxy with path-based routing using backloop.dev certificates.
 * Routes series requests to HFS, everything else to API server.
 *
 * Usage: node proxy.js [<listen-port>] [<api-port>] [<hfs-port>]
 * Defaults: listen=3000, api=3001, hfs=4000
 */

const https = require('node:https');
const http = require('node:http');
const httpsOptionsAsync = require('backloop.dev').httpsOptionsAsync;

const LISTEN_PORT = parseInt(process.argv[2]) || 3000;
const API_PORT = parseInt(process.argv[3]) || 3001;
const HFS_PORT = parseInt(process.argv[4]) || 4000;

// Pattern: /:username/events/:id/series (HFS handles series data)
const HFS_PATTERN = /\/[^/]+\/events\/[^/]+\/series/;

httpsOptionsAsync(function (err, httpsOptions) {
  if (err) { console.error(err); process.exit(1); }

  https.createServer(httpsOptions, function (clientReq, clientRes) {
    const targetPort = HFS_PATTERN.test(clientReq.url) ? HFS_PORT : API_PORT;
    const headers = Object.assign({ 'x-forwarded-proto': 'https' }, clientReq.headers);

    const proxy = http.request({
      hostname: '127.0.0.1',
      port: targetPort,
      path: clientReq.url,
      method: clientReq.method,
      headers
    }, function (res) {
      clientRes.writeHead(res.statusCode, res.headers);
      res.pipe(clientRes, { end: true });
    });

    proxy.on('error', function (e) {
      clientRes.statusCode = 502;
      clientRes.end('Proxy error: ' + e.message);
    });

    clientReq.pipe(proxy, { end: true });
  }).listen(LISTEN_PORT, function () {
    console.log('HTTPS proxy on :' + LISTEN_PORT + ' → API :' + API_PORT + ' / HFS :' + HFS_PORT);
    if (process.send) process.send({ ready: true });
  });
});
