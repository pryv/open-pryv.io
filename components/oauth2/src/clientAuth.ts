/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/**
 * OAuth2: client authentication helpers shared by the endpoints that
 * authenticate a client (the token endpoint today). No route module in
 * here, so any endpoint can import it without a cycle.
 */

/**
 * Decode RFC 6749 §2.3.1 Basic credentials from an Authorization
 * header. Returns null if absent or malformed. The values are URL-
 * decoded per spec (the header carries percent-encoded credentials).
 */
export function decodeBasicAuth (headerValue: unknown): { client_id: string; client_secret: string } | null {
  if (typeof headerValue !== 'string') return null;
  // RFC 7617 §2: the `Basic` auth-scheme name is case-INSENSITIVE (`basic`,
  // `BASIC`, … are all valid). The base64 credentials stay strict.
  const m = headerValue.match(/^Basic\s+([A-Za-z0-9+/=]+)\s*$/i);
  if (m == null) return null;
  let decoded: string;
  try {
    decoded = Buffer.from(m[1], 'base64').toString('utf8');
  } catch {
    return null;
  }
  const idx = decoded.indexOf(':');
  if (idx <= 0) return null;
  try {
    return {
      client_id: decodeURIComponent(decoded.slice(0, idx)),
      client_secret: decodeURIComponent(decoded.slice(idx + 1)),
    };
  } catch {
    return null;
  }
}
