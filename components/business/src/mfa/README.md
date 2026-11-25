# MFA methods

Two second-factor methods are built in: `totp` (authenticator app, RFC 6238, verified in-process) and `sms` (any HTTP
message provider, in `single` or `challenge-verify` mode). The set is closed: a new method is a change to this code, not
a plugin. Operator documentation: https://pryv.github.io/customer-resources/mfa/ (configuration, and the NIST SP 800-63B
level each method reaches).

## The contract

Every method implements `MfaMethod` (`MfaMethod.ts`). The API layer (`components/api-server/src/methods/mfa.ts`) drives
it in this order:

1. `checkEnrolParams(params)`: validate the `mfa.activate` body (step-up fields already removed) before anything
   happens; throw `invalid-parameters-format` on a key the method does not accept.
2. `enroll(username, profile, params)`: prepare a pending enrolment on the `Profile` (set `profile.method`, store what
   the method needs). It sends nothing. Fields it returns are merged into the reply (TOTP returns the `otpauthUri`).
3. `challenge(username, profile, clientRequest)`: called once the MFA session exists, at activation, at login and on a
   re-send. `clientRequest.sessionId` and `clientRequest.userId` are set; send the code here if the method sends one.
4. `verify(username, profile, clientRequest)`: check `clientRequest.body.code`; throw `invalid-mfa-code` on a bad one.

The per-session and per-account attempt limits, the backoff and the step-up are handled by the API layer for every
method; a method only says whether a code is right.

## Adding a method

- **Implementation:** a class implementing `MfaMethod` with a unique `name`, next to `TotpService.ts`.
- **Registry:** `getMFAMethod` in `index.ts` builds methods by name (one cached instance per process); add the branch
  and the name to its error message. `getMFAMethodForProfile` resolves a stored profile's `method`.
- **Configuration:** `normalizeMfaConfig` in `index.ts` (the `services.mfa.methods.<name>` block and its defaults),
  `configCheck.ts` (boot refusals for settings that cannot work), then `config/default-config.yml`, the production
  config and the install wizard's config appendix (`bin/init.js`).
- **Profile:** `Profile.ts` (`isActive` per method, and what reading the private profile shows: never a secret).
- **API:** the `method` parameter of `mfa.activate` (`components/api-server/src/schema/mfaMethods.ts`) and any
  method-specific branch in `methods/mfa.ts` (TOTP has two: the replay guard and the step-up by code).
- **Tests:** unit tests beside `components/business/test/unit/mfa-TotpService.test.js` and
  `mfa-configCheck.test.js`, and the API flow in `components/api-server/test/mfa.test.js` (activate, confirm, login,
  verify, recovery, step-up, wrong codes).
- **Docs:** the operator page above, its table of levels included.

Secrets a method keeps (TOTP's shared secret) are stored encrypted at rest; follow `totpKeys.ts`.
