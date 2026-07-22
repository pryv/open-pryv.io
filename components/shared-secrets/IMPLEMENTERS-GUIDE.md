# Shared secrets — Implementer's Guide

> The customer-facing wire shape. This document becomes a public page on
> `pryv.github.io` when the feature ships there.

## Elevator pitch

You need to hand a secret — usually an apiEndpoint with an access token — to a
third party. Don't put it in a URL, where it ends up in browser history,
`Referer` headers and access logs. Store it on the account and hand over a
**random one-time key**. The recipient redeems the key, once, for the secret,
using nothing but the key itself.

## The three calls

All paths are under `https://<username>.<domain>/shared-secrets` (or the dnsLess
equivalent). The key **always travels in the request body**, never the URL.

### 1. Create — `POST /shared-secrets` (authenticated)

```json
{
  "ttl": 300,
  "title": "Share my clinic token",
  "onConsumed": {
    "message": "This sharing link has already been used.",
    "returnUrl": "https://example.com/back"
  },
  "secret": { "apiEndpoint": "https://token@alice.pryv.me/" }
}
```

| Field | Required | Notes |
|---|---|---|
| `ttl` | yes | seconds the key stays redeemable; must be > 0 and ≤ `sharedSecrets.maxTtl` (default 30 d). No default — you choose. |
| `title` | yes | shown to the account owner. |
| `onConsumed.message` | yes | returned to whoever presents the key once it is no longer available. |
| `onConsumed.returnUrl` | no | must be `http(s)` — it is followed by an unauthenticated third party. |
| `secret` | yes | any non-null JSON; serialized size ≤ `sharedSecrets.maxSizeBytes` (default 4096). |
| `signature` | no | see [Signatures](#signatures). |
| `keyHash` | no | client-supplied key material — see [Two creation modes](#two-creation-modes). |

Response (server-minted mode):

```json
{ "sharedSecret": {
  "id": "ck…", "key": "ck….aVPZ…", "status": "pending",
  "title": "Share my clinic token", "expires": 1784624534
} }
```

**`key` is returned exactly once.** The server keeps only its SHA-256; it cannot
be recovered later. Hand the key to the third party (in a POST body, a header,
anything but a logged URL).

### 2. Redeem — `POST /shared-secrets/retrieve` (NO auth)

The redeemer has no Pryv credentials yet — the key is the credential.

```json
{ "key": "ck….aVPZ…" }
```

Success (`200`):

```json
{ "secret": { "apiEndpoint": "https://token@alice.pryv.me/" } }
```

Refusal (`403`) — consumed, expired, or discarded:

```json
{ "error": { "id": "shared-secret-unavailable",
  "message": "This sharing link has already been used.",
  "data": { "returnUrl": "https://example.com/back" } } }
```

Unknown or malformed keys get a single uniform refusal, so the endpoint cannot be
used to discover which ids exist.

### 3. Inspect — `POST /shared-secrets/status` (authenticated)

For the creating access or a personal token, to check state without consuming:

```json
{ "key": "ck….aVPZ…" }
```

returns the item's status/metadata (never the secret). An item past its TTL is
reported `discarded` with `"expired": true`, even before anyone touches it.

## Two creation modes

- **Server-minted (default).** Omit `keyHash`; the server generates the key and
  returns it once. Simplest — use this unless you need an `hmac-sha256` signature.
- **Client key material.** Supply `keyHash` = hex SHA-256 of a random half you
  generate yourself (≥192 bits). The response then carries **no** `key`; you
  compose it as `<id>.<yourRandomHalf>`. This exists so an `hmac-sha256` signature
  can be bound to the key material *before* the item is created.

`pryv.SharedSecrets` in lib-js handles both modes for you.

## Signatures

A signature gates redemption on a proof. A **wrong** proof discards the secret; a
**missing** proof is refused without burning it (so a client can prompt and retry).

- `secret` — `{ "type": "secret", "value": "<passphrase>" }` at creation; the
  redeemer sends `{ "signature": { "type": "secret", "payload": "<passphrase>" } }`.
  The passphrase is shared out-of-band and scrubbed from the item once consumed.
- `hmac-sha256` — the redeemer proves knowledge of a verifier secret shared
  out-of-band, by sending `HMAC-SHA256(verifierSecret, keyMaterial)`. The verifier
  secret never reaches the server. Use the client-key-material mode so the proof
  binds to the key.

## Using the lib-js helper

```js
const pryv = require('pryv');

// creator (has a Connection)
const shared = await pryv.SharedSecrets.create(connection, {
  ttl: 300, title: 'Share my token',
  onConsumed: { message: 'already used' },
  secret: { apiEndpoint: myEndpoint }
});
handOff(shared.key);            // returned once

// redeemer (no credentials — just the account's apiEndpoint + the key)
const { secret } = await pryv.SharedSecrets.retrieve(apiEndpoint, key);
```

For an `hmac-sha256` signature, pass `signature: { type: 'hmac-sha256',
verifierSecret }` to `create`, and `{ verifierSecret }` to `retrieve` — the
helper generates the key material and computes the proof client-side.

## Error ids

`shared-secret-invalid-ttl`, `shared-secret-ttl-too-long`,
`shared-secret-invalid-title`, `shared-secret-invalid-on-consumed`,
`shared-secret-invalid-return-url`, `shared-secret-missing-secret`,
`shared-secret-too-large`, `shared-secret-invalid-signature`,
`shared-secret-invalid-key-hash` (create); `shared-secret-forbidden` (access
barred by the `secretSharing` opt-out); `shared-secret-unavailable` (redeem of a
non-pending / expired item); `shared-secret-immutable`,
`shared-secret-reserved-stream`, `shared-secret-reserved-type` (attempts to reach
the namespace through the ordinary events/streams API).

## Listing, reading, purging (standard API)

Shared secrets are ordinary events under `:_shared-secrets:<accessId>`, so:
- **List your own**: `events.get` with `streams: [":_shared-secrets:<accessId>"]`
  (add `state: "trashed"` for consumed/discarded ones). They never appear in a
  wildcard `*` query.
- **Erase**: `events.delete` on a terminal item purges the record (the secret is
  already gone). Deleting a still-pending item discards it.
- Creating, updating or moving a `shared-secret/item` through the events API is
  refused — the endpoints above are the only way in.

## Barring an access from minting shared secrets

Add the feature permission `{ "feature": "secretSharing", "setting": "forbidden" }`
to an access (e.g. a publicly-exposed token). Any child access it creates
inherits the bar, and the inheritance cannot be stripped via `accesses.update`.
