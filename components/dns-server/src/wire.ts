/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/**
 * Request-validation on the raw wire buffer, per RFC 1035 section 4.
 *
 * The embedded DNS server validates every incoming message here BEFORE any
 * full decoder sees it. The goals are strict input conformance, a hard bound
 * on the work any single request can cause, and a classification the caller
 * maps to one of: no reply, a header-only error reply, a question-echoing
 * REFUSED, or a normal answer. Name parsing always terminates: compression
 * pointers must move strictly backwards and the hop count is capped.
 */

/** DNS response codes used in classifications (RFC 1035 section 4.1.1). */
export const RCODE_FORMERR = 1;
export const RCODE_NOTIMP = 4;
export const RCODE_REFUSED = 5;

/** OPCODE QUERY (RFC 1035 section 4.1.1); the only opcode this server serves. */
const OPCODE_QUERY = 0;

/** QCLASS IN (RFC 1035 section 3.2.4); the only class this server serves. */
const QCLASS_IN = 1;

/**
 * Smallest legal DNS message is a 12-octet header. The upper bound is the
 * conventional EDNS-less safe-size ceiling (1232 octets): this server offers
 * no EDNS, so a larger datagram is not something a conformant client sends.
 */
const MIN_MESSAGE = 12;
const MAX_MESSAGE = 1232;

/** Label and name limits (RFC 1035 section 2.3.4 / 3.1). */
const MAX_LABEL = 63;
const MAX_NAME = 255;

/** Compression-pointer safety: at most this many pointer hops per name. */
const MAX_POINTER_HOPS = 16;

/** The two high bits of a length octet select the label type (RFC 1035 section 4.1.4). */
const LABEL_MASK = 0xc0;
const LABEL_NORMAL = 0x00;
const LABEL_POINTER = 0xc0;

/** The dot octet; a label that contains one is refused (it cannot be a hostname label). */
const DOT = 0x2e;

export type WireHeader = { id: number; opcode: number; rd: number };

export type WireResult =
  /** Drop silently: no reply at all. */
  | { kind: 'ignore'; reason: string }
  /** Header-only error reply, qdcount 0 (NOTIMP / FORMERR). */
  | { kind: 'error'; rcode: number; reason: string; header: WireHeader }
  /** REFUSED echoing the question (class not IN, or a dot inside a label). */
  | { kind: 'refused'; reason: string; header: WireHeader; name: string; type: number; qclass: number; rawQuestion: Buffer }
  /** A conformant single-question QUERY to dispatch. */
  | { kind: 'ok'; header: WireHeader; name: string; type: number; qclass: number; rawQuestion: Buffer };

type ParsedName =
  | { ok: true; name: string; endOffset: number; dotInLabel: boolean }
  | { ok: false };

/**
 * Parse one domain name starting at `start`. Enforces every RFC 1035 wire
 * limit and guarantees termination. Returns the decoded name, the offset in
 * the buffer just past the name as it is written at `start` (so the caller can
 * read QTYPE/QCLASS and splice the raw question), and whether any label held a
 * dot octet. Returns `{ ok: false }` for any structural violation (the caller
 * maps that to FORMERR).
 */
export function parseName (buf: Buffer, start: number): ParsedName {
  const labels: string[] = [];
  let offset = start;
  let nameOctets = 0;
  let hops = 0;
  let dotInLabel = false;
  let endOffset = -1; // offset past the name as written at `start`
  let segmentStart = start; // pointers must target strictly before this

  for (;;) {
    if (offset >= buf.length) return { ok: false };
    const len = buf[offset];
    const labelType = len & LABEL_MASK;

    if (len === 0) {
      offset++;
      if (endOffset === -1) endOffset = offset;
      break;
    }

    if (labelType === LABEL_NORMAL) {
      if (len > MAX_LABEL) return { ok: false };
      const from = offset + 1;
      const to = from + len;
      if (to > buf.length) return { ok: false };
      nameOctets += len + 1;
      if (nameOctets > MAX_NAME) return { ok: false };
      const label = buf.subarray(from, to);
      if (label.includes(DOT)) dotInLabel = true;
      labels.push(label.toString('latin1'));
      offset = to;
      continue;
    }

    if (labelType === LABEL_POINTER) {
      if (offset + 1 >= buf.length) return { ok: false };
      if (++hops > MAX_POINTER_HOPS) return { ok: false };
      const target = ((len & 0x3f) << 8) | buf[offset + 1];
      if (endOffset === -1) endOffset = offset + 2;
      // Target must be inside the message past the header AND strictly before
      // the start of the current segment: this forces every jump backwards, so
      // parsing cannot cycle.
      if (target < MIN_MESSAGE || target >= segmentStart) return { ok: false };
      segmentStart = target;
      offset = target;
      continue;
    }

    // Reserved label types 0x40 / 0x80.
    return { ok: false };
  }

  return { ok: true, name: labels.join('.'), endOffset, dotInLabel };
}

/**
 * Classify a raw inbound DNS message. Pure: the UDP caller additionally drops
 * a datagram whose source port is 0 (see `isIgnorableUdpSource`).
 */
export function validateRequest (buf: Buffer): WireResult {
  if (buf.length < MIN_MESSAGE) return { kind: 'ignore', reason: 'short' };
  if (buf.length > MAX_MESSAGE) return { kind: 'ignore', reason: 'oversized' };

  const flags = buf.readUInt16BE(2);
  const qr = (flags >> 15) & 0x1;
  if (qr === 1) return { kind: 'ignore', reason: 'response' };

  const id = buf.readUInt16BE(0);
  const opcode = (flags >> 11) & 0xf;
  const rd = (flags >> 8) & 0x1;
  const header: WireHeader = { id, opcode, rd };

  if (opcode !== OPCODE_QUERY) {
    return { kind: 'error', rcode: RCODE_NOTIMP, reason: 'opcode', header };
  }

  const qdcount = buf.readUInt16BE(4);
  const arcount = buf.readUInt16BE(10);
  // ancount (6) and nscount (8) are deliberately not parsed or echoed.
  if (qdcount !== 1) return { kind: 'error', rcode: RCODE_FORMERR, reason: 'qdcount', header };
  if (arcount > 1) return { kind: 'error', rcode: RCODE_FORMERR, reason: 'arcount', header };

  const parsed = parseName(buf, MIN_MESSAGE);
  if (!parsed.ok) return { kind: 'error', rcode: RCODE_FORMERR, reason: 'qname', header };

  // QTYPE + QCLASS follow the name.
  if (parsed.endOffset + 4 > buf.length) {
    return { kind: 'error', rcode: RCODE_FORMERR, reason: 'question', header };
  }
  const type = buf.readUInt16BE(parsed.endOffset);
  const qclass = buf.readUInt16BE(parsed.endOffset + 2);
  const rawQuestion = Buffer.from(buf.subarray(MIN_MESSAGE, parsed.endOffset + 4));

  if (qclass !== QCLASS_IN) {
    return { kind: 'refused', reason: 'class', header, name: parsed.name, type, qclass, rawQuestion };
  }
  if (parsed.dotInLabel) {
    return { kind: 'refused', reason: 'dot-in-label', header, name: parsed.name, type, qclass, rawQuestion };
  }

  return { kind: 'ok', header, name: parsed.name, type, qclass, rawQuestion };
}

/** A UDP datagram whose source port is 0 cannot be replied to: drop it. */
export function isIgnorableUdpSource (port: number): boolean {
  return port === 0;
}
