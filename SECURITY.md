# Security Policy

## Reporting a Vulnerability

We take security seriously. Please do not report suspected vulnerabilities in public GitHub issues. Use a private channel so maintainers can investigate and coordinate a fix before details are disclosed.

### Preferred: GitHub Security Advisory

Open a private advisory for this repository at:

https://github.com/pryv/open-pryv.io/security/advisories/new

GitHub advisories support private collaboration, coordinated publication, and CVE assignment when applicable.

### Alternative: Email

If GitHub private vulnerability reporting is unavailable, contact Pryv through the security contact published on https://www.pryv.com or the support contact listed for your Pryv deployment. Do not include sensitive proof-of-concept details in public tickets.

Please include:

- A description of the vulnerability and affected component.
- Reproduction steps or a minimal proof-of-concept.
- Affected version, Docker tag, release branch, or commit SHA.
- Your assessment of impact and any known exploitation conditions.

## What to Expect

| Stage | Target time |
| --- | --- |
| Initial acknowledgement | Within 72 hours |
| Triage and severity decision | Within 14 days |
| High-severity fix or mitigation target | Within 90 days |
| Medium-severity fix or mitigation target | Within 180 days |
| Public advisory | After a fix or mitigation is available, or by coordinated agreement |

Timelines can change when a fix requires ecosystem coordination, reporter-requested delay, or additional validation. Maintainers should keep reporters updated when that happens.

## Scope

In scope:

- The `pryv/open-pryv.io` codebase on active release branches.
- Official `pryvio/open-pryv.io` Docker images.
- Default configuration behavior for a fresh deployment.

Out of scope:

- Operator-customized deployments, data, or infrastructure not controlled by Pryv.
- Third-party plugins, custom storage engines, and downstream forks unless the issue also affects this repository.
- Social engineering, physical attacks, spam, phishing, or attacks against Pryv employees, users, or partners.
- Denial-of-service testing without prior written coordination.
- Vulnerabilities in third-party dependencies that do not require a Pryv-specific fix.

## Safe Harbor

We will not pursue legal action against researchers who make a good-faith effort to follow this policy, avoid privacy violations, avoid data destruction or service disruption, and report findings promptly through a private channel.

Safe harbor does not cover accessing other users' data, persistence after proving impact, extortion, public disclosure before coordination, or activity outside the scope above.

## Coordinated Disclosure

We follow coordinated disclosure. Public details should be released after a fix or mitigation is available, or on a mutually agreed timeline. For confirmed high-severity issues, a 90-day disclosure window is the default target unless both parties agree otherwise.

Confirmed vulnerabilities may be documented with a GitHub Security Advisory, CVE, release note, or changelog entry as appropriate.

## Recognition and Bounties

Pryv may credit reporters for verified good-faith disclosures when they want public acknowledgement. Rewards are not guaranteed unless an official bounty program or written agreement explicitly says otherwise.
