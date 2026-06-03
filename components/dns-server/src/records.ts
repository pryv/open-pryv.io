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
  return { name, type: Packet.TYPE.AAAA, class: Packet.CLASS.IN, ttl, address };
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

function buildTXT (name: string, data: string, ttl: number): BaseRecord & { data: string } {
  return { name, type: Packet.TYPE.TXT, class: Packet.CLASS.IN, ttl, data };
}

function buildCAA (name: string, flags: number, tag: string, value: string, ttl: number): BaseRecord & { flags: number; tag: string; value: string } {
  return { name, type: Packet.TYPE.CAA, class: Packet.CLASS.IN, ttl, flags, tag, value };
}

export { buildA, buildAAAA, buildCNAME, buildMX, buildNS, buildSOA, buildTXT, buildCAA };
