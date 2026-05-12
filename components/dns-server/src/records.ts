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
const require = createRequire(import.meta.url);

const dns2 = require('dns2');
const { Packet } = dns2;

function buildA (name: any, address: any, ttl: any) {
  return { name, type: Packet.TYPE.A, class: Packet.CLASS.IN, ttl, address };
}

function buildAAAA (name: any, address: any, ttl: any) {
  return { name, type: Packet.TYPE.AAAA, class: Packet.CLASS.IN, ttl, address };
}

function buildCNAME (name: any, domain: any, ttl: any) {
  return { name, type: Packet.TYPE.CNAME, class: Packet.CLASS.IN, ttl, domain };
}

function buildMX (name: any, exchange: any, priority: any, ttl: any) {
  return { name, type: Packet.TYPE.MX, class: Packet.CLASS.IN, ttl, exchange, priority };
}

function buildNS (name: any, ns: any, ttl: any) {
  return { name, type: Packet.TYPE.NS, class: Packet.CLASS.IN, ttl, ns };
}

function buildSOA (name: any, { primary, admin, serial, refresh, retry, expiration, minimum }: any, ttl: any) {
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

function buildTXT (name: any, data: any, ttl: any) {
  return { name, type: Packet.TYPE.TXT, class: Packet.CLASS.IN, ttl, data };
}

function buildCAA (name: any, flags: any, tag: any, value: any, ttl: any) {
  return { name, type: Packet.TYPE.CAA, class: Packet.CLASS.IN, ttl, flags, tag, value };
}

export { buildA, buildAAAA, buildCNAME, buildMX, buildNS, buildSOA, buildTXT, buildCAA };
