
## 1.9

### 1.9.3
- Added Audit from Entreprise version to Open-Pryv.io.

### 1.9.2
- Refactored Attachments (Event Files) Logic to be modular for future cloud storage of files such as S3.

### 1.9.1
- Implemented ferretDB compatibility allowing full-open source modules
- Replaced rec.la by backloop.dev

### 1.9.0

- Remove FlowType and convert (best-effort) typing information into JSDoc comments
- Update to MongoDB v6
- Update to node v18
- Stream deletion eventIds when deleting streams to avoid timeout
- Introduce platform DB for future cross-cores usage
- Unify SQLite usage across audit and storage
- Move attachments to per-user directories
- Finalize data-store API for first public release
- Many linting fixes
- Support for multiple CAA (certificate autorities issuer)
- Bug fixes:
  - Non-reusable deleted streamIds when following auth process #484
  - SQLITE_BUSY error thrown in multi-core #487

## 1.8

### 1.8.1

- Fix migration 1.6.x to 1.8.0 bug

### 1.8.0

- Add support for password rules: complexity, age, reuse; see API server's `auth.password*` settings
  - Affected methods are: create user (`POST /users`), change password (`{user endpoint}/account/change-password`), reset password (`{user endpoint}/account/reset-password`) and login (`{user endpoint}/auth/login`)
- Add undocumented support for external stores (a.k.a. "data mapping" feature); see component `pryv-datastore` (will be published separately when appropriate)

## 1.7

### 1.7.14
- Fix crash caused by permissions selfRevoke used in combinaison with BACKWARD_COMPATIBILITY_SYSTEM_STREAMS_PREFIX set to true.
- Fix issue with `accesses.create` theand selfRevoke permissions that was only possible with a personalToken.

### 1.7.13

- Fix another issue when BACKWARD_COMPATIBILITY_SYSTEM_STREAMS_PREFIX is set to "true" - children streams' ids were not following the correct format
- Fix a performance issue when querying events by type
- Fix an issue which caused the service not to restart properly in some situations

### 1.7.12

- Fix issue when BACKWARD_COMPATIBILITY_SYSTEM_STREAMS_PREFIX is set to "true" - "account" streamId was handled as ".account"

### 1.7.10

- API change: Don't coerce event content and simplify known type validation process in api-server
- serviceInfo:eventTypes URL now supports `file://` protocol allowing it to load definition from file system

### 1.7.9

- Fix issue with events.getAttachment making core crash if filename contained fancy characters by putting it in the 'Content-disposition' header
- Security fix: make password reset token single-use
- Security fix: hide "newPassword" in logs when an error occurs in account.resetPassword

### 1.7.7

- Fix issue where a deleted user was kept in the cache, thus rendering the reuse of username possible, but failing all subsequent calls as the password and tokens were not returned (since the wrong userId was returned by the cache)
- Fix issue where attempting to create streams with id 'size' would return an error
- Fix socket.io CORS issue

### 1.7.6

- Fix access-info permissions

### 1.7.5

- add missing system stream permissions accesses
- change __unique properties cleanup, just match them by key suffix, not from current serializer unique props. Avoids migration error if uniqueness has been modified.


### 1.7.1

- migrate tags into streams

### 1.7.0

- introduce mall abstraction
- add integrity
- refactor access permissions logic

## 1.6

### 1.6.21

Fixes:

- fix boolean/bool event type that was not allowed
- fix HF null values for optional values that was not fully working

Changes:

- increase username characters limit to 60

### 1.6.20

- Implement system route to deactivate MFA

### 1.6.18

- Fix welcome email: don't wait for welcome email sending before replying to client.

### 1.6.16

- Fix versioning: update unique system events bug

### 1.6.15

- Fix user deletion

### 1.6.14

- personal token can delete an account
- add external licenser: pryv/app-node-licenser
- fix security issue with users registration conflicts leaking random email addresses

### 1.6.13

- Unify configuration into boiler
- Fixes for Open Pryv.io

### 1.6.12

Fixes:

- versioning now works when trashing event

### 1.6.7

New Features:

- Stream queries for events.get

Fixes:

- usernames starting with "system" are available
- personal token expiration now fixed
- Users create call on core username error message now specifies that letters must be lowercase

Changes:

- In configuration, rename "singleNode" to "dnsLess", keeping retro-compatibility for "singleNode" with warning message

Removals:

- Deprecated "GET /who-am-i" API method removed
- Remove pryvuser-cli code (the image was not built since July)

### 1.6.3

Custom Auth function now has access to all headers.

### 1.6.2

- Fix migration that was skipping passwordHash leading to users not being able to login
- add errors if this cases arises

### 1.6.1

Fixes for dnsLess/openSource:

- /reg/service/info
- dependencies
- boost POST payload to 10MB for HF server

### 1.6.0

system streams:

- customizable (& extendable) unique and indexed account properties
- access to account properties through the events API with its access management
- user account deletion through administration API