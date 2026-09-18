/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/**
 * HTTPS proxy with path-based routing using backloop.dev certificates.
 * Routes series requests to HFS, everything else to API server.
 * Forwards WebSocket upgrades (Socket.IO uses transports: ['websocket']).
 *
 * Usage: node proxy.js [<listen-port>] [<api-port>] [<hfs-port>]
 * Defaults: listen=3000, api=3001, hfs=4000
 */

const https = require('node:https');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const httpsOptionsAsync = require('backloop.dev').httpsOptionsAsync;

const LISTEN_PORT = parseInt(process.argv[2]) || 3000;
const API_PORT = parseInt(process.argv[3]) || 3001;
const HFS_PORT = parseInt(process.argv[4]) || 4000;

// Pattern: /:username/events/:id/series (HFS handles series data)
const HFS_PATTERN = /\/[^/]+\/events\/[^/]+\/series/;

function targetPortFor (url) {
  return HFS_PATTERN.test(url) ? HFS_PORT : API_PORT;
}

// Service assets (`service.assets.definitions` in config/libjs-test-config.yml)
// are served from local fixtures, so the lib-js assets and auth tests do not
// depend on reaching the public assets site.
const ASSETS_PREFIX = '/test-assets/';
const ASSETS_DIR = path.resolve(__dirname, 'fixtures/assets');
const ASSET_TYPES = { '.json': 'application/json', '.css': 'text/css', '.html': 'text/html' };

function serveAsset (clientReq, clientRes) {
  let file = null;
  try {
    // decodeURIComponent throws on a malformed escape: answer 404, keep the proxy up.
    const rel = decodeURIComponent(clientReq.url.split('?')[0].slice(ASSETS_PREFIX.length));
    const candidate = path.resolve(ASSETS_DIR, rel);
    if (candidate.startsWith(ASSETS_DIR + path.sep) && fs.statSync(candidate).isFile()) file = candidate;
  } catch (_e) {
    file = null;
  }
  if (file == null) {
    clientRes.writeHead(404, { 'Content-Type': 'text/plain' });
    return clientRes.end('Not found');
  }
  clientRes.writeHead(200, {
    'Content-Type': ASSET_TYPES[path.extname(file)] || 'application/octet-stream',
    'Access-Control-Allow-Origin': '*'
  });
  fs.createReadStream(file).pipe(clientRes);
}

httpsOptionsAsync(function (err, httpsOptions) {
  if (err) { console.error(err); process.exit(1); }

  const server = https.createServer(httpsOptions, function (clientReq, clientRes) {
    if (clientReq.url.startsWith(ASSETS_PREFIX)) return serveAsset(clientReq, clientRes);
    const headers = Object.assign({ 'x-forwarded-proto': 'https' }, clientReq.headers);

    const proxy = http.request({
      hostname: '127.0.0.1',
      port: targetPortFor(clientReq.url),
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
  });

  server.on('upgrade', function (clientReq, clientSocket, head) {
    const proxyReq = http.request({
      hostname: '127.0.0.1',
      port: targetPortFor(clientReq.url),
      path: clientReq.url,
      method: clientReq.method,
      headers: clientReq.headers
    });

    proxyReq.on('upgrade', function (proxyRes, proxySocket, proxyHead) {
      let response = 'HTTP/1.1 101 Switching Protocols\r\n';
      for (let i = 0; i < proxyRes.rawHeaders.length; i += 2) {
        response += proxyRes.rawHeaders[i] + ': ' + proxyRes.rawHeaders[i + 1] + '\r\n';
      }
      clientSocket.write(response + '\r\n');
      if (proxyHead && proxyHead.length > 0) clientSocket.write(proxyHead);
      if (head && head.length > 0) proxySocket.write(head);
      proxySocket.pipe(clientSocket);
      clientSocket.pipe(proxySocket);
      proxySocket.on('error', function () { clientSocket.destroy(); });
      clientSocket.on('error', function () { proxySocket.destroy(); });
    });

    // Backend answered with a regular response instead of switching protocols
    proxyReq.on('response', function (res) {
      clientSocket.end('HTTP/1.1 ' + res.statusCode + ' ' + (res.statusMessage || '') + '\r\nConnection: close\r\n\r\n');
    });

    proxyReq.on('error', function () { clientSocket.destroy(); });
    proxyReq.end();
  });

  server.listen(LISTEN_PORT, function () {
    console.log('HTTPS proxy on :' + LISTEN_PORT + ' → API :' + API_PORT + ' / HFS :' + HFS_PORT);
    if (process.send) process.send({ ready: true });
  });
});
