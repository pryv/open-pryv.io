/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

// Types for the parts of `proxy-addr` (2.x, no published types) used by clientIp.ts.
declare module 'proxy-addr' {
  import type { IncomingHttpHeaders } from 'node:http';

  /** Whether the address at `index` in the forwarded chain (0 = the TCP peer) is trusted. */
  type TrustFn = (addr: string, index: number) => boolean;

  /** What proxy-addr reads: the headers and the TCP peer (from `socket`, else `connection`). */
  type RequestLike = {
    headers: IncomingHttpHeaders;
    socket?: { remoteAddress?: string } | null;
    connection?: { remoteAddress?: string } | null;
  };

  interface ProxyAddr {
    /** The client address: the forwarded chain walked from the right while entries are trusted. */
    (req: RequestLike, trust: TrustFn | string | string[]): string;
    /** The peer then every forwarded address, up to the first untrusted one. */
    all (req: RequestLike, trust?: TrustFn | string | string[]): string[];
    /** Compiles IPs, CIDRs and the names loopback / linklocal / uniquelocal; throws on an invalid entry. */
    compile (val: string | string[]): TrustFn;
  }

  const proxyaddr: ProxyAddr;
  export default proxyaddr;
}
