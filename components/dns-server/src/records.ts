/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */


/**
 * Pure helper functions to build dns2 answer objects.
 */

import { createRequire } from 'node:module';
import { isIPv6 } from 'node:net';
import { toCharacterStrings } from './recordValidation.ts';
const require = createRequire(import.meta.url);

const dns2 = require('dns2');
const { Packet } = dns2;

/**
 * Expand an IPv6 address to eight colon-separated hex groups. dns2's IPv6
 * encoder mis-handles the compact `::ffff:a.b.c.d` form (and other `::`
 * placements), so we hand it a fully expanded address it encodes correctly.
 * Returns the input unchanged when it is not a parseable IPv6 address (the
 * serve-time record check then skips it).
 */
function normalizeIPv6 (address: string): string {
  if (typeof address !== 'string' || !isIPv6(address)) return address;
  const expandEmbeddedV4 = (parts: string[]): string[] => {
    const out: string[] = [];
    for (const p of parts) {
      if (p.includes('.')) {
        const o = p.split('.').map((n) => parseInt(n, 10));
        if (o.length === 4 && o.every((n) => Number.isInteger(n) && n >= 0 && n <= 255)) {
          out.push((((o[0] << 8) | o[1]) >>> 0).toString(16));
          out.push((((o[2] << 8) | o[3]) >>> 0).toString(16));
          continue;
        }
      }
      out.push(p);
    }
    return out;
  };
  const halves = address.split('::');
  let groups: string[];
  if (halves.length === 1) {
    groups = expandEmbeddedV4(address.split(':'));
  } else {
    const head = halves[0] ? expandEmbeddedV4(halves[0].split(':')) : [];
    const tail = halves[1] ? expandEmbeddedV4(halves[1].split(':')) : [];
    const missing = 8 - head.length - tail.length;
    if (missing < 0) return address;
    groups = [...head, ...Array(missing).fill('0'), ...tail];
  }
  if (groups.length !== 8) return address;
  return groups.map((g) => (parseInt(g, 16) || 0).toString(16)).join(':');
}

interface BaseRecord {
  name: string;
  type: number;
  class: number;
  ttl: number;
}

interface SoaFields {
  primary: string;
  admin: string;
  serial: number;
  refresh: number;
  retry: number;
  expiration: number;
  minimum: number;
}

function buildA (name: string, address: string, ttl: number): BaseRecord & { address: string } {
  return { name, type: Packet.TYPE.A, class: Packet.CLASS.IN, ttl, address };
}

function buildAAAA (name: string, address: string, ttl: number): BaseRecord & { address: string } {
  return { name, type: Packet.TYPE.AAAA, class: Packet.CLASS.IN, ttl, address: normalizeIPv6(address) };
}

function buildCNAME (name: string, domain: string, ttl: number): BaseRecord & { domain: string } {
  return { name, type: Packet.TYPE.CNAME, class: Packet.CLASS.IN, ttl, domain };
}

function buildMX (name: string, exchange: string, priority: number, ttl: number): BaseRecord & { exchange: string; priority: number } {
  return { name, type: Packet.TYPE.MX, class: Packet.CLASS.IN, ttl, exchange, priority };
}

function buildNS (name: string, ns: string, ttl: number): BaseRecord & { ns: string } {
  return { name, type: Packet.TYPE.NS, class: Packet.CLASS.IN, ttl, ns };
}

function buildSOA (name: string, { primary, admin, serial, refresh, retry, expiration, minimum }: SoaFields, ttl: number): BaseRecord & SoaFields {
  return {
    name,
    type: Packet.TYPE.SOA,
    class: Packet.CLASS.IN,
    ttl,
    primary,
    admin,
    serial,
    refresh,
    retry,
    expiration,
    minimum
  };
}

function buildTXT (name: string, data: string, ttl: number): BaseRecord & { data: string[] } {
  // Split into <= 255-octet character-strings: dns2 writes each element's
  // length in a single octet, so a value over 255 bytes would corrupt the wire.
  return { name, type: Packet.TYPE.TXT, class: Packet.CLASS.IN, ttl, data: toCharacterStrings(data) };
}

function buildCAA (name: string, flags: number, tag: string, value: string, ttl: number): BaseRecord & { flags: number; tag: string; value: string } {
  return { name, type: Packet.TYPE.CAA, class: Packet.CLASS.IN, ttl, flags, tag, value };
}

export { buildA, buildAAAA, buildCNAME, buildMX, buildNS, buildSOA, buildTXT, buildCAA };
