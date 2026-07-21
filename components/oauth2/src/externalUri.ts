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
 */

export interface UriSource {
  protocol?: string;
  originalUrl?: string;
  url?: string;
  headers?: Record<string, unknown>;
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
  const proto = firstHeaderValue(headers['x-forwarded-proto']) ?? req.protocol ?? 'http';
  const host = firstHeaderValue(headers['x-forwarded-host']) ?? firstHeaderValue(headers.host);
  if (host == null) throw new Error('cannot reconstruct the request URI: no Host header');
  const rawPath = req.originalUrl ?? req.url ?? '/';
  const path = rawPath.split('?')[0].split('#')[0];
  return `${proto}://${host}${path.startsWith('/') ? path : '/' + path}`;
}
