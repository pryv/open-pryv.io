# components/shared-secrets — one-time secret hand-off (`:_shared-secrets:`)

> **Living design.** This README is the canonical design document for the
> shared-secrets plugin. Companions in this directory:
> - [IMPLEMENTERS-GUIDE.md](IMPLEMENTERS-GUIDE.md) — customer-facing wire shape (API consumers).
> - [INTERNALS.md](INTERNALS.md) — storage model, guard seams, and security review notes.

**Status:** Released to `master`. Client SDK ships as `pryv.SharedSecrets` in the
[`pryv`](https://github.com/pryv/lib-js) npm package. Event type
`shared-secret/item` is published in
[`data-types`](https://github.com/pryv/data-types).

## The problem

Handing a secret to a third party — most often an apiEndpoint carrying an access
token — has meant putting it in a URL. A URL is the worst possible carrier: it
survives in browser history, in `Referer` headers, and in every server access
log it passes through. The credential outlives the moment it was needed.

## The primitive

Store the secret on the account and hand over a **random one-time key** instead.
The third party redeems the key, exactly once, for the secret — with no
credentials of their own, because the key IS the credential.

- **One-shot.** A key is redeemable exactly once; concurrent redemptions resolve
  to a single winner (database compare-and-set). Every later attempt returns the
  creator's "no longer available" message.
- **Mandatory TTL.** Expiry is the item's own `time + duration`; there is no
  default, a caller must decide the lifetime.
- **Hash-only at rest.** The server stores only `SHA-256` of the key's random
  half. The clear key exists once, in the creation response, and cannot be
  recovered afterwards by anyone — a database dump yields no live credential.
- **Scrubbed on use.** The secret (and any signature passphrase) is removed the
  moment the item stops being pending, and never enters event history.
- **Optional proof.** A `secret` (passphrase) or `hmac-sha256` signature can gate
  redemption; for HMAC the verifier secret is never sent to the server.

## Design pillars

1. **Plugin, not storage engine.** Lives at `components/shared-secrets/`; every
   item is an ordinary event in standard per-user main storage (PG / SQLite),
   addressed by the streamId prefix `:_shared-secrets:` — the same discipline as
   the CMC plugin. No new storage primitive.
2. **One namespace, one substream per creating access.** Items live under
   `:_shared-secrets:<accessId>`, provisioned lazily on first use (write **and**
   read paths). An access sees only its own substream; the namespace never
   answers a wildcard `events.get`.
3. **Three thin HTTP routes, everything else is the events API.** `POST
   /shared-secrets` (create), `POST /shared-secrets/retrieve` (redeem,
   unauthenticated), `POST /shared-secrets/status` (inspect). The key always
   travels in the request body, never the URL — the exposure this feature exists
   to remove. Listing, reading and purging reuse `events.get` / `events.getOne`
   / `events.delete` on the namespace.
4. **The events API cannot subvert the lifecycle.** Guards refuse creating,
   modifying or moving a shared-secret event by hand; deleting a pending item
   discards it, deleting a terminal one purges it (the erasure path).
5. **Opt-out is inherited.** The `secretSharing` feature permission bars an
   access from minting shared secrets, and any child access it creates inherits
   the bar un-strippably.

## Configuration

```yaml
sharedSecrets:
  enabled: true          # inert unless called; existing deployments unaffected
  maxSizeBytes: 4096      # cap on the serialized `secret` payload
  maxTtl: 2592000         # seconds (30 days); ttl is mandatory, no default
```

Read per request, so an operator toggle takes effect without a restart. Disabling
the feature also stops already-issued keys from redeeming.

## Where the code is

```
src/
  constants.ts     namespace, event type, statuses, streamId helpers
  key.ts           key mint/parse, SHA-256, HMAC, constant-time compare, expiry
  item.ts          content shape, validation, status transitions, public view
  provisioning.ts  lazy stream provisioning (create + read paths)
  guards.ts        write guards on the namespace (events + streams)
  index.ts         barrel
```

The HTTP surface and orchestration live in api-server:
`components/api-server/src/methods/shared-secrets.ts` (the three methods),
`components/api-server/src/routes/shared-secrets.ts` (routes; retrieve is
unauthenticated). The guards are wired into the `events.*` and `streams.*` method
chains. See [INTERNALS.md](INTERNALS.md) for the seams.
