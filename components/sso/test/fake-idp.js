/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/**
 * In-process fake OpenID Provider for SSO tests.
 *
 * A real (tiny) HTTP server on an ephemeral 127.0.0.1 port exposing the four
 * endpoints openid-client needs — discovery, JWKS, authorize, token — signing
 * REAL RS256 id_tokens with a generated key so openid-client's verification
 * path runs for real (no stubbing). Per-test knobs drive the refusal matrix:
 * wrong signing key, wrong `aud`/`iss`, expired token, `email_verified:false`,
 * or a missing nonce are all produced by tweaking one control and re-signing.
 *
 * Serves plain http on 127.0.0.1; the provider registry only enables
 * openid-client's insecure-transport path for an `http:` issuer, which real
 * config forbids — so this stays a test-only door.
 */

import http from 'node:http';
import crypto from 'node:crypto';
import * as jose from 'jose';

/**
 * Start a fake IdP. Returns `{ issuer, clientId, clientSecret, control, close }`.
 * `control` mutates what the NEXT token mint produces (all optional):
 *   { sub, email, emailVerified, audOverride, issOverride, expOverride,
 *     omitNonce, signingKey: 'primary'|'secondary' }
 */
export async function startFakeIdp (opts = {}) {
  const clientId = opts.clientId ?? 'test-client-id';
  const clientSecret = opts.clientSecret ?? 'test-client-secret';

  const primary = await jose.generateKeyPair('RS256', { extractable: true });
  const secondary = await jose.generateKeyPair('RS256', { extractable: true });
  const primaryJwk = { ...(await jose.exportJWK(primary.publicKey)), kid: 'primary', alg: 'RS256', use: 'sig' };

  // Default identity + per-test overrides.
  const control = {
    sub: opts.sub ?? 'idp-subject-123',
    email: opts.email ?? 'user@example.com',
    emailVerified: opts.emailVerified ?? true,
    audOverride: null,
    issOverride: null,
    expOverride: null,
    omitNonce: false,
    signingKey: 'primary'
  };

  // code -> { nonce, codeChallenge, redirectUri }
  const codes = new Map();

  let issuer = '';

  function sendJson (res, code, body) {
    const payload = JSON.stringify(body);
    res.writeHead(code, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) });
    res.end(payload);
  }

  async function mintIdToken (nonce) {
    const now = Math.floor(Date.now() / 1000);
    const claims = { email: control.email, email_verified: control.emailVerified };
    if (!control.omitNonce && nonce != null) claims.nonce = nonce;
    const key = control.signingKey === 'secondary' ? secondary.privateKey : primary.privateKey;
    return await new jose.SignJWT(claims)
      .setProtectedHeader({ alg: 'RS256', kid: 'primary' })
      .setIssuer(control.issOverride ?? issuer)
      .setSubject(control.sub)
      .setAudience(control.audOverride ?? clientId)
      .setIssuedAt(now)
      .setExpirationTime(control.expOverride ?? (now + 300))
      .sign(key);
  }

  function readBody (req) {
    return new Promise((resolve) => {
      let data = '';
      req.on('data', (c) => { data += c; });
      req.on('end', () => resolve(data));
    });
  }

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, issuer);
      const path = url.pathname;

      if (req.method === 'GET' && path === '/.well-known/openid-configuration') {
        return sendJson(res, 200, {
          issuer,
          authorization_endpoint: issuer + '/authorize',
          token_endpoint: issuer + '/token',
          jwks_uri: issuer + '/jwks',
          response_types_supported: ['code'],
          subject_types_supported: ['public'],
          id_token_signing_alg_values_supported: ['RS256'],
          scopes_supported: ['openid', 'email'],
          token_endpoint_auth_methods_supported: ['client_secret_basic', 'client_secret_post'],
          code_challenge_methods_supported: ['S256'],
          claims_supported: ['sub', 'email', 'email_verified', 'iss', 'aud', 'exp', 'iat', 'nonce']
        });
      }

      if (req.method === 'GET' && path === '/jwks') {
        return sendJson(res, 200, { keys: [primaryJwk] });
      }

      if (req.method === 'GET' && path === '/authorize') {
        const q = url.searchParams;
        const code = 'code-' + crypto.randomBytes(12).toString('hex');
        codes.set(code, {
          nonce: q.get('nonce'),
          codeChallenge: q.get('code_challenge'),
          redirectUri: q.get('redirect_uri')
        });
        const redirect = new URL(q.get('redirect_uri'));
        redirect.searchParams.set('code', code);
        if (q.get('state') != null) redirect.searchParams.set('state', q.get('state'));
        res.writeHead(302, { location: redirect.href });
        return res.end();
      }

      if (req.method === 'POST' && path === '/token') {
        const body = new URLSearchParams(await readBody(req));
        const code = body.get('code');
        const entry = code != null ? codes.get(code) : null;
        if (entry == null) return sendJson(res, 400, { error: 'invalid_grant' });
        codes.delete(code); // one-time
        // PKCE S256 check — required (a flow that omitted the challenge is a
        // bug we want the tests to catch, not silently accept).
        const verifier = body.get('code_verifier') ?? '';
        const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
        if (entry.codeChallenge == null || challenge !== entry.codeChallenge) {
          return sendJson(res, 400, { error: 'invalid_grant', error_description: 'pkce mismatch' });
        }
        const idToken = await mintIdToken(entry.nonce);
        return sendJson(res, 200, {
          access_token: 'access-' + crypto.randomBytes(8).toString('hex'),
          id_token: idToken,
          token_type: 'Bearer',
          expires_in: 300
        });
      }

      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('not found');
    } catch (err) {
      sendJson(res, 500, { error: 'server_error', detail: String(err && err.message) });
    }
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  issuer = `http://127.0.0.1:${port}`;

  return {
    issuer,
    clientId,
    clientSecret,
    control,
    close: () => new Promise((resolve) => server.close(resolve))
  };
}
