# Security Policy

We take the security of open-pryv.io seriously. If you believe you have
found a security vulnerability, please report it to us privately through
one of the channels below. **Please do not open a public GitHub issue for
security vulnerabilities** - public disclosure before a fix is available
puts every deployment at risk.

## Reporting a Vulnerability

### Preferred: GitHub private vulnerability reporting

Open a private advisory at
https://github.com/pryv/open-pryv.io/security/advisories/new

This gives us integrated CVE issuance, a private space to collaborate
with you on a fix, and coordinated-disclosure tooling.

### Alternative: email

Send your report to **security-dev@pryv.com**.

Please include as much of the following as you can:

- A description of the vulnerability.
- Reproduction steps or a proof-of-concept.
- The affected version(s) or commit SHA.
- Your assessment of the impact.

## What to expect

| Stage | Target time |
|---|---|
| Initial acknowledgement | within 72 hours |
| Triage and severity decision | within 14 days |
| Fix or mitigation (high severity) | within 90 days |
| Fix or mitigation (medium severity) | within 180 days |
| Public advisory and CVE | after the fix ships, or 90 days from triage, whichever comes first |

## Scope

**In scope**

- The `pryv/open-pryv.io` codebase (`master` branch and active release
  branches).
- The official Docker images published at `pryvio/open-pryv.io`.
- The default-configuration behaviour of a fresh deployment.

**Out of scope**

- Operator-customised deployments and configurations.
- Third-party plugins or custom data stores.
- Social-engineering or physical attacks against personnel or facilities.
- Denial-of-service testing without prior written coordination.
- Vulnerabilities in dependencies (please report those to the upstream
  maintainer; cross-link us if the issue specifically affects
  open-pryv.io).

## Safe harbor

We will not pursue legal action against researchers who report
vulnerabilities in good faith and in compliance with this policy.
Activities that exceed the scope above - for example accessing other
users' data, prolonged denial of service, or attempts to monetise
findings outside this program - are not covered by this assurance.

## Coordinated disclosure

We follow a 90-day coordinated-disclosure timeline for high-severity
issues; longer windows are negotiable on request. A public advisory and
CVE are issued after the fix ships, or 90 days from triage, whichever
comes first. Confirmed vulnerabilities are published as GitHub Security
Advisories with a CVE where applicable.

## Recognition

We do not run a paid bounty program, but we gratefully credit researchers
who report verified vulnerabilities in good faith. With your consent, we
acknowledge you by name (or handle) in the published GitHub Security
Advisory and credit you in the CVE record. This hall of fame is our way
of thanking the people who help keep open-pryv.io secure.
