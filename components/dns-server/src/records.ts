/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */


import type {} from 'node:fs';

/**
 * Pure helper functions to build dns2 answer objects.
 */

const dns2 = require('dns2');
const { Packet } = dns2;

function buildA (name, address, ttl) {
  return { name, type: Packet.TYPE.A, class: Packet.CLASS.IN, ttl, address };
}

function buildAAAA (name, address, ttl) {
  return { name, type: Packet.TYPE.AAAA, class: Packet.CLASS.IN, ttl, address };
}

function buildCNAME (name, domain, ttl) {
  return { name, type: Packet.TYPE.CNAME, class: Packet.CLASS.IN, ttl, domain };
}

function buildMX (name, exchange, priority, ttl) {
  return { name, type: Packet.TYPE.MX, class: Packet.CLASS.IN, ttl, exchange, priority };
}

function buildNS (name, ns, ttl) {
  return { name, type: Packet.TYPE.NS, class: Packet.CLASS.IN, ttl, ns };
}

function buildSOA (name, { primary, admin, serial, refresh, retry, expiration, minimum }, ttl) {
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

function buildTXT (name, data, ttl) {
  return { name, type: Packet.TYPE.TXT, class: Packet.CLASS.IN, ttl, data };
}

function buildCAA (name, flags, tag, value, ttl) {
  return { name, type: Packet.TYPE.CAA, class: Packet.CLASS.IN, ttl, flags, tag, value };
}

module.exports = {
  buildA,
  buildAAAA,
  buildCNAME,
  buildMX,
  buildNS,
  buildSOA,
  buildTXT,
  buildCAA
};
