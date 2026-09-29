/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { buildHostedSitesIngress, checkStaticSiteFolders, checkHostedSitesAtBoot } = require('../src/hostedSitesIngress.ts');
const { describeHostedSites } = require('business/src/hostedSites.ts');

const DOMAIN = 'pryv.test';
const quietLogger = { debug: () => {}, info: () => {}, warn: () => {} };

/** Parse a hostedSites block the way the core does (DNS topology unless told otherwise). */
function sitesOf (hostedSites, extra = {}) {
  const r = describeHostedSites(Object.assign({ hostedSites, domain: DOMAIN, dnsLessActive: false }, extra));
  assert.deepEqual(r.problems, []);
  return r.sites;
}

/** One request against a server; resolves { status, headers, body }. */
function request (port, { method = 'GET', path: reqPath = '/', host, headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const allHeaders = Object.assign({}, headers);
    if (host != null) allHeaders.host = host;
    const r = http.request({ host: '127.0.0.1', port, method, path: reqPath, headers: allHeaders }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString() }));
    });
    r.on('error', reject);
    r.end(body);
  });
}

function listen (handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

function close (server) {
  return new Promise((resolve) => server.close(() => resolve()));
}

describe('[HSTI] hosted sites in-process dispatcher', function () {
  let tmp, root, bareRoot;

  before(function () {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hsti-'));
    root = path.join(tmp, 'site');
    fs.mkdirSync(path.join(root, 'nested'), { recursive: true });
    fs.mkdirSync(path.join(root, 'assets'));
    fs.mkdirSync(path.join(root, '.git'));
    fs.writeFileSync(path.join(root, 'index.html'), '<p>home</p>');
    fs.writeFileSync(path.join(root, 'auth.html'), '<p>auth</p>');
    fs.writeFileSync(path.join(root, 'nested', 'index.html'), '<p>nested</p>');
    fs.writeFileSync(path.join(root, 'assets', 'app.js'), 'console.log(1);');
    fs.writeFileSync(path.join(root, '404.html'), '<p>custom 404</p>');
    fs.writeFileSync(path.join(root, '.git', 'config'), 'secret-git');
    fs.writeFileSync(path.join(root, '.env'), 'secret-env');
    fs.writeFileSync(path.join(tmp, 'outside.txt'), 'secret-outside');
    fs.symlinkSync(path.join(tmp, 'outside.txt'), path.join(root, 'escape.txt'));
    fs.symlinkSync(tmp, path.join(root, 'escapedir'));
    fs.symlinkSync(path.join(root, 'auth.html'), path.join(root, 'alias.html'));
    bareRoot = path.join(tmp, 'bare');
    fs.mkdirSync(bareRoot);
    fs.writeFileSync(path.join(bareRoot, 'index.html'), '<p>bare</p>');
    fs.mkdirSync(path.join(root, 'café'));
    fs.writeFileSync(path.join(root, 'café', 'index.html'), '<p>cafe</p>');
  });

  after(function () {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  describe('[HST1] static site, DNS topology', function () {
    let front, port, fallbackCalls;

    before(async function () {
      const dispatch = buildHostedSitesIngress({
        sites: sitesOf({
          account: { static: root, headers: { 'content-security-policy': "default-src 'self'" } },
          bare: { static: bareRoot, headers: { 'cache-control': 'no-store' } }
        }),
        domain: DOMAIN,
        dnsLess: false,
        logger: quietLogger
      });
      front = await listen((req, res) => dispatch(req, res, (rq, rs) => {
        fallbackCalls++;
        rs.writeHead(200, { 'content-type': 'text/plain' });
        rs.end('api');
      }));
      port = front.address().port;
    });
    beforeEach(function () { fallbackCalls = 0; });
    after(async function () { await close(front); });

    const get = (p, extra = {}) => request(port, Object.assign({ path: p, host: 'account.' + DOMAIN }, extra));

    it('[HSTA] serves index.html at the root and in a nested folder, with the site headers', async function () {
      const r = await get('/');
      assert.equal(r.status, 200);
      assert.equal(r.body, '<p>home</p>');
      assert.match(r.headers['content-type'], /^text\/html/);
      assert.equal(r.headers['cache-control'], 'public, max-age=0');
      assert.equal(r.headers['x-content-type-options'], 'nosniff');
      assert.equal(r.headers['referrer-policy'], 'strict-origin-when-cross-origin');
      assert.equal(r.headers['content-security-policy'], "default-src 'self'");
      assert.equal(r.headers['strict-transport-security'], undefined, 'no HSTS over plain http');
      assert.equal(r.headers['access-control-allow-origin'], undefined);
      assert.equal(r.headers['api-version'], undefined);
      assert.equal((await get('/nested/')).body, '<p>nested</p>');
      const redirect = await get('/nested?x=1');
      assert.equal(redirect.status, 301);
      assert.equal(redirect.headers.location, '/nested/?x=1');
      // the redirect target stays percent-encoded
      const cafe = await get('/caf%C3%A9');
      assert.equal(cafe.status, 301);
      assert.equal(cafe.headers.location, '/caf%C3%A9/');
      assert.equal((await get(cafe.headers.location)).body, '<p>cafe</p>');
      assert.equal(fallbackCalls, 0);
    });

    it('[HSTB] /auth serves auth.html; an unknown path serves 404.html with status 404', async function () {
      const auth = await get('/auth');
      assert.equal(auth.status, 200);
      assert.equal(auth.body, '<p>auth</p>');
      const miss = await get('/nope/deeper');
      assert.equal(miss.status, 404);
      assert.equal(miss.body, '<p>custom 404</p>');
      assert.match(miss.headers['content-type'], /^text\/html/);
      assert.equal(miss.headers['x-content-type-options'], 'nosniff');
      // a site without 404.html answers a one-line text 404
      const bare = await request(port, { path: '/nope', host: 'bare.' + DOMAIN });
      assert.equal(bare.status, 404);
      assert.equal(bare.body, 'Not Found\n');
      assert.match(bare.headers['content-type'], /^text\/plain/);
    });

    it('[HSTC] assets carry their content type and an ETag; If-None-Match answers 304', async function () {
      const r = await get('/assets/app.js');
      assert.equal(r.status, 200);
      assert.match(r.headers['content-type'], /javascript/);
      assert.ok(r.headers.etag);
      assert.ok(r.headers['last-modified']);
      const again = await get('/assets/app.js', { headers: { 'if-none-match': r.headers.etag } });
      assert.equal(again.status, 304);
      assert.equal(again.body, '');
      const range = await get('/assets/app.js', { headers: { range: 'bytes=0-6' } });
      assert.equal(range.status, 206);
      assert.equal(range.body, 'console');
      const unsatisfiable = await get('/assets/app.js', { headers: { range: 'bytes=1000-2000' } });
      assert.equal(unsatisfiable.status, 416);
      assert.equal(unsatisfiable.headers['content-range'], 'bytes */' + 'console.log(1);'.length);
    });

    it('[HSTD] encoded dot segments, NUL bytes and bad encodings never reach outside the folder', async function () {
      for (const p of ['/../outside.txt', '/%2e%2e/outside.txt', '/assets/%2e%2e/%2e%2e/outside.txt',
        '/%2e%2e%2foutside.txt', '/assets%2f..%2f..%2foutside.txt', '/..%5coutside.txt']) {
        const r = await get(p);
        assert.notEqual(r.status, 200, p);
        assert.ok(!r.body.includes('secret'), p + ' leaked: ' + r.body);
      }
      assert.equal((await get('/index.html%00.js')).status, 400);
      assert.equal((await get('/%E0%A4%A')).status, 400);
    });

    it('[HSTE] dotfiles and symlinks out of the folder answer 404; a symlink inside is served', async function () {
      for (const p of ['/.git/config', '/.env', '/.git/', '/escape.txt', '/escapedir/outside.txt']) {
        const r = await get(p);
        assert.equal(r.status, 404, p);
        assert.ok(!r.body.includes('secret'), p + ' leaked: ' + r.body);
      }
      const alias = await get('/alias.html');
      assert.equal(alias.status, 200);
      assert.equal(alias.body, '<p>auth</p>');
    });

    it('[HSTF] methods: POST answers 405 with Allow; HEAD has headers and no body', async function () {
      const post = await get('/', { method: 'POST', body: 'x'.repeat(100000), headers: { 'content-type': 'text/plain' } });
      assert.equal(post.status, 405);
      assert.equal(post.headers.allow, 'GET, HEAD');
      const head = await get('/', { method: 'HEAD' });
      assert.equal(head.status, 200);
      assert.equal(head.body, '');
      assert.equal(head.headers['content-length'], String('<p>home</p>'.length));
      const headMiss = await get('/nope', { method: 'HEAD' });
      assert.equal(headMiss.status, 404);
      assert.equal(headMiss.body, '');
    });

    it('[HSTG] Host matching: exact name, any case, with a port or a trailing dot; everything else falls through', async function () {
      assert.equal((await get('/', { host: 'ACCOUNT.Pryv.Test:3000' })).body, '<p>home</p>');
      assert.equal((await get('/', { host: 'account.pryv.test.' })).body, '<p>home</p>');
      for (const host of ['alice.' + DOMAIN, 'account.' + DOMAIN + '.evil.org', 'x.account.' + DOMAIN, DOMAIN, 'account']) {
        const r = await get('/', { host });
        assert.equal(r.body, 'api', host);
      }
      // the dnsLess prefix form is not a site path in the DNS topology
      assert.equal((await request(port, { path: '/account/', host: 'core.' + DOMAIN })).body, 'api');
      assert.equal(fallbackCalls, 6);
    });

    it('[HSTQ] no Host header (HTTP/1.0) falls through to the API', async function () {
      const net = require('node:net');
      const raw = await new Promise((resolve, reject) => {
        const sock = net.connect(port, '127.0.0.1', () => sock.end('GET / HTTP/1.0\r\n\r\n'));
        let data = '';
        sock.on('data', (c) => { data += c; });
        sock.on('end', () => resolve(data));
        sock.on('error', reject);
      });
      assert.match(raw, /^HTTP\/1\.[01] 200/);
      assert.ok(raw.endsWith('api'), raw);
      assert.equal(fallbackCalls, 1);
    });

    it('[HSTR] the operator headers win over the ones send sets', async function () {
      const r = await request(port, { path: '/', host: 'bare.' + DOMAIN });
      assert.equal(r.status, 200);
      assert.equal(r.headers['cache-control'], 'no-store');
    });
  });

  describe('[HST2] dnsLess path prefix', function () {
    let front, port;

    before(async function () {
      const dispatch = buildHostedSitesIngress({
        sites: sitesOf({ account: { static: root } }, { domain: null, dnsLessActive: true }),
        domain: null,
        dnsLess: true,
        logger: quietLogger
      });
      front = await listen((req, res) => dispatch(req, res, (rq, rs) => { rs.end('api'); }));
      port = front.address().port;
    });
    after(async function () { await close(front); });

    it('[HSTH] /account redirects to /account/, which serves the folder; other paths fall through', async function () {
      const redirect = await request(port, { path: '/account?x=1' });
      assert.equal(redirect.status, 301);
      assert.equal(redirect.headers.location, '/account/?x=1');
      assert.equal((await request(port, { path: '/account/' })).body, '<p>home</p>');
      assert.equal((await request(port, { path: '/account/auth' })).body, '<p>auth</p>');
      const nested = await request(port, { path: '/account/nested' });
      assert.equal(nested.headers.location, '/account/nested/');
      assert.equal((await request(port, { path: '/account/nope' })).status, 404);
      for (const p of ['/accounts/x', '/alice/events', '/', '/reg/service/info', '/xaccount/']) {
        assert.equal((await request(port, { path: p })).body, 'api', p);
      }
      // encoded dot segments leave the prefix: the request is no longer the site's
      assert.equal((await request(port, { path: '/account/%2e%2e/escape.txt' })).body, 'api');
      const escape = await request(port, { path: '/account/assets/%2e%2e/%2e%2e/%2e%2e/outside.txt' });
      assert.ok(!escape.body.includes('secret'));
    });
  });

  describe('[HST3] proxy site', function () {
    let upstream, upstreamPort, lastUpstream, upstreamMode;
    let front, port;

    before(async function () {
      upstream = await listen((req, res) => {
        lastUpstream = { method: req.method, url: req.url, headers: req.headers };
        if (upstreamMode === 'hang') return; // never answers
        if (upstreamMode === 'error') {
          res.writeHead(500, { 'content-type': 'text/plain' });
          res.end('upstream broke');
          return;
        }
        if (req.url.startsWith('/docs/redirect-abs')) {
          res.writeHead(301, { location: `http://127.0.0.1:${upstreamPort}/docs/target/` });
          res.end();
          return;
        }
        if (req.url.startsWith('/docs/redirect-rel')) {
          res.writeHead(302, { location: '/docs/other/' });
          res.end();
          return;
        }
        if (req.url.startsWith('/docs/redirect-away')) {
          res.writeHead(302, { location: 'https://elsewhere.example/x' });
          res.end();
          return;
        }
        res.writeHead(200, {
          'content-type': 'text/html',
          etag: '"v1"',
          'set-cookie': 'sid=upstream',
          'strict-transport-security': 'max-age=1; includeSubDomains',
          'content-security-policy': 'default-src *',
          'x-upstream-private': 'yes',
          'access-control-allow-origin': '*',
          'cache-control': 'max-age=600'
        });
        res.end(req.method === 'HEAD' ? undefined : 'upstream:' + req.url);
      });
      upstreamPort = upstream.address().port;
      const dispatch = buildHostedSitesIngress({
        sites: sitesOf({ docs: { proxy: `http://127.0.0.1:${upstreamPort}/docs`, headers: { 'x-frame-options': 'DENY', 'cache-control': 'no-store' } } }),
        domain: DOMAIN,
        dnsLess: false,
        logger: quietLogger,
        upstreamIdleTimeoutMs: 300
      });
      front = await listen((req, res) => dispatch(req, res, (rq, rs) => { rs.end('api'); }));
      port = front.address().port;
    });
    beforeEach(function () { lastUpstream = null; upstreamMode = 'ok'; });
    after(async function () {
      upstream.closeAllConnections();
      await close(upstream);
      await close(front);
    });

    const get = (p, extra = {}) => request(port, Object.assign({ path: p, host: 'docs.' + DOMAIN }, extra));

    it('[HSTI] joins the upstream base with the request path and query', async function () {
      const r = await get('/guide/intro.html?lang=fr&x=1');
      assert.equal(r.status, 200);
      assert.equal(r.body, 'upstream:/docs/guide/intro.html?lang=fr&x=1');
      assert.equal(lastUpstream.method, 'GET');
      assert.equal((await get('/')).body, 'upstream:/docs/');
      // leading slashes cannot turn the path into another host
      assert.equal((await get('//evil.example/x')).body, 'upstream:/docs/evil.example/x');
    });

    it('[HSTJ] forwards only the allow-listed request headers; Host is the upstream', async function () {
      await get('/p', {
        headers: {
          cookie: 'sid=client',
          authorization: 'Bearer client-token',
          'x-forwarded-for': '1.2.3.4',
          'x-custom': 'nope',
          accept: 'text/html',
          'accept-language': 'fr',
          'if-none-match': '"v0"',
          'user-agent': 'hsti-test'
        }
      });
      const h = lastUpstream.headers;
      assert.equal(h.host, `127.0.0.1:${upstreamPort}`);
      assert.equal(h.cookie, undefined);
      assert.equal(h.authorization, undefined);
      assert.equal(h['x-forwarded-for'], undefined);
      assert.equal(h['x-custom'], undefined);
      assert.equal(h.accept, 'text/html');
      assert.equal(h['accept-language'], 'fr');
      assert.equal(h['if-none-match'], '"v0"');
      assert.equal(h['user-agent'], 'hsti-test');
    });

    it('[HSTK] passes only the allow-listed response headers and adds the site headers', async function () {
      const r = await get('/p');
      assert.equal(r.headers['content-type'], 'text/html');
      assert.equal(r.headers.etag, '"v1"');
      assert.equal(r.headers['set-cookie'], undefined);
      assert.equal(r.headers['strict-transport-security'], undefined);
      assert.equal(r.headers['content-security-policy'], undefined);
      assert.equal(r.headers['x-upstream-private'], undefined);
      assert.equal(r.headers['access-control-allow-origin'], undefined);
      assert.equal(r.headers['x-content-type-options'], 'nosniff');
      assert.equal(r.headers['x-frame-options'], 'DENY');
      // the operator's header wins over the upstream's allow-listed one
      assert.equal(r.headers['cache-control'], 'no-store');
    });

    it('[HSTL] rewrites a Location inside the upstream base to the site; keeps others', async function () {
      assert.equal((await get('/redirect-abs')).headers.location, '/target/');
      assert.equal((await get('/redirect-rel')).headers.location, '/other/');
      assert.equal((await get('/redirect-away')).headers.location, 'https://elsewhere.example/x');
    });

    it('[HSTM] upstream status passes through; HEAD has no body; POST answers 405 without reaching upstream', async function () {
      upstreamMode = 'error';
      const r = await get('/p');
      assert.equal(r.status, 500);
      assert.equal(r.body, 'upstream broke');
      upstreamMode = 'ok';
      const head = await get('/p', { method: 'HEAD' });
      assert.equal(head.status, 200);
      assert.equal(head.body, '');
      assert.equal(lastUpstream.method, 'HEAD');
      lastUpstream = null;
      const post = await get('/p', { method: 'POST', body: 'x' });
      assert.equal(post.status, 405);
      assert.equal(lastUpstream, null);
    });

    it('[HSTN] upstream idle answers 504; upstream down answers 502', async function () {
      upstreamMode = 'hang';
      const r = await get('/slow');
      assert.equal(r.status, 504);
      assert.equal(r.body, 'Gateway Timeout\n');
      assert.equal(r.headers['x-content-type-options'], 'nosniff');
      assert.equal(r.headers['x-frame-options'], 'DENY');

      const downDispatch = buildHostedSitesIngress({
        sites: sitesOf({ docs: { proxy: 'http://127.0.0.1:1/docs/' } }),
        domain: DOMAIN,
        dnsLess: false,
        logger: quietLogger
      });
      const down = await listen((req, res) => downDispatch(req, res, () => assert.fail('no fallback')));
      try {
        const d = await request(down.address().port, { path: '/x', host: 'docs.' + DOMAIN });
        assert.equal(d.status, 502);
        assert.equal(d.body, 'Bad Gateway\n');
        assert.equal(d.headers['x-content-type-options'], 'nosniff');
      } finally {
        await close(down);
      }
    });

    it('[HSTO] an upstream inside dns.domain is refused when the dispatcher is built', function () {
      const loop = new Map([['docs', { name: 'docs', kind: 'proxy', upstream: 'https://other.' + DOMAIN + '/', headers: {} }]]);
      assert.throws(() => buildHostedSitesIngress({ sites: loop, domain: DOMAIN, dnsLess: false, logger: quietLogger }), /points at this platform/);
      assert.throws(() => buildHostedSitesIngress({ sites: sitesOf({ a: { static: root } }), domain: null, dnsLess: false, logger: quietLogger }), /dns.domain/);
    });
  });

  describe('[HST4] boot folder check', function () {
    it('[HSTP] a missing folder or a folder without index.html is reported; a complete one is not', function () {
      const empty = path.join(tmp, 'empty');
      fs.mkdirSync(empty, { recursive: true });
      const problems = checkStaticSiteFolders(sitesOf({
        good: { static: root },
        missing: { static: path.join(tmp, 'does-not-exist') },
        empty: { static: empty },
        docs: { proxy: 'https://e.org/' }
      }));
      assert.equal(problems.length, 2);
      assert.ok(problems[0].includes('hostedSites.missing'));
      assert.ok(problems[1].includes('hostedSites.empty'));
    });

    it('[HSTS] a site name equal to a core id or to an existing username is reported', async function () {
      const sites = sitesOf({ 'core-b': { static: root }, taken: { static: root }, free: { static: root } });
      const problems = await checkHostedSitesAtBoot(
        sites,
        { usernameExistsOnPlatform: async (name) => name === 'taken' },
        { getAllCoreInfos: async () => [{ id: 'core-a' }, { id: 'Core-B' }] }
      );
      assert.equal(problems.length, 2, problems.join('|'));
      assert.ok(problems.some((p) => p.includes('hostedSites.core-b') && p.includes('id of a core')));
      assert.ok(problems.some((p) => p.includes('hostedSites.taken') && p.includes('user')));
    });
  });
});
