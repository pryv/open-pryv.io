/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/**
 * Reconstruct the CLIENT-FACING request URI — the value a DPoP client
 * signs into `htu`. Uses `req.originalUrl` (captured by express at app
 * entry, BEFORE the in-app rewrites that mutate `req.url`) and honours
 * the standard reverse-proxy forwarding headers, falling back to the
 * transport's own view. Query and fragment are dropped — htu is
 * compared without them (RFC 9449 §4.3).
 *
 * X-Forwarded-Host / X-Forwarded-Proto are only read when the request
 * comes from a trusted proxy (`http.trustedProxies`, the same list as the
 * client address in the audit log). From any other peer they are ignored
 * and the transport's own view is used (`Host`, and `req.protocol`, which
 * express computes with the same trust setting): otherwise a client
 * reaching the core directly could make a proof minted for another host
 * pass. The path segment comes from `originalUrl`, not headers, so
 * cross-endpoint replay stays blocked by the path compare regardless.
 */
import { trustedProxyFn } from 'middleware/src/clientIp.ts';

export interface UriSource {
  protocol?: string;
  originalUrl?: string;
  url?: string;
  headers?: Record<string, unknown>;
  socket?: { remoteAddress?: string; encrypted?: boolean } | null;
  connection?: { remoteAddress?: string } | null;
}

function fromTrustedProxy (req: UriSource): boolean {
  const peer = req.socket?.remoteAddress ?? req.connection?.remoteAddress;
  return peer != null && trustedProxyFn()(peer, 0);
}

function firstHeaderValue (raw: unknown): string | null {
  const v = Array.isArray(raw) ? raw[0] : raw;
  if (typeof v !== 'string' || v.length === 0) return null;
  // Forwarding headers may carry a comma-joined proxy chain; the first
  // entry is the client-facing edge.
  return v.split(',')[0].trim();
}

export function externalRequestUri (req: UriSource): string {
  const headers = req.headers ?? {};
  const forwarded = fromTrustedProxy(req);
  const ownProto = req.protocol ?? (req.socket?.encrypted ? 'https' : 'http');
  const proto = (forwarded ? firstHeaderValue(headers['x-forwarded-proto']) : null) ?? ownProto;
  const host = (forwarded ? firstHeaderValue(headers['x-forwarded-host']) : null) ?? firstHeaderValue(headers.host);
  if (host == null) throw new Error('cannot reconstruct the request URI: no Host header');
  const rawPath = req.originalUrl ?? req.url ?? '/';
  const path = rawPath.split('?')[0].split('#')[0];
  return `${proto}://${host}${path.startsWith('/') ? path : '/' + path}`;
}
