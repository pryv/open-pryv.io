/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

/**
 * Account/system-stream permission validation for any access other than the
 * personal one, applied wherever such an access is minted or changed:
 * accesses.create, accesses.update and the consent accept that mints a
 * data-grant. Returns the first violating permission as an APIError, or null
 * when the whole set is acceptable.
 */

const errors = require('errors').factory;
const ErrorIds = require('errors').ErrorIds;
const ErrorMessages = require('errors').ErrorMessages;
const accountStreams = require('business/src/system-streams/index.ts');
const storeDataUtils = require('mall/src/helpers/storeDataUtils.ts');

const ACCOUNT_ROOT_LEVEL_MESSAGE = "The account root stream can only be granted at the 'read' or 'none' level; grant the account fields themselves to write them.";

type PermissionLike = { streamId?: unknown; level?: unknown };

function validateAccountStreamPermissions (permissions: PermissionLike[]) {
  const notVisibleAccountStreamsIds: string[] = accountStreams.hiddenStreamIds;
  const visibleAccountStreamsIds = Object.keys(accountStreams.accountMap).filter(id => accountStreams.accountMap[id].isShown);
  for (const permission of permissions) {
    if (typeof permission.streamId !== 'string') continue;
    // Judge, and store, the canonical spelling: `:account::system:email`
    // or `:local::system:email` name the same account field as
    // `:system:email`, and the checks below compare exact ids.
    permission.streamId = storeDataUtils.canonicalStreamId(permission.streamId);
    const streamId = permission.streamId as string;
    if (isUnknownSystemStream(streamId)) {
      return errors.invalidOperation(ErrorMessages[ErrorIds.UnknownAccountStream], { param: streamId });
    }
    // The account root grants its level on every account field below it,
    // hidden ones included: it can be read or locked, never written.
    if (streamId === accountStreams.STREAM_ID_ACCOUNT &&
        permission.level !== 'read' && permission.level !== 'none') {
      return errors.invalidOperation(ACCOUNT_ROOT_LEVEL_MESSAGE, { param: streamId, level: permission.level });
    }
    // don't allow user to give access to not visible stream
    if (notVisibleAccountStreamsIds.includes(streamId)) {
      return errors.invalidOperation(ErrorMessages[ErrorIds.DeniedStreamAccess], { param: streamId });
    }
    // a visible account field can be granted at 'read' (or 'none') only:
    // the personal access is the one writer of account fields
    if (visibleAccountStreamsIds.includes(streamId) &&
        permission.level !== 'read' && permission.level !== 'none') {
      return errors.invalidOperation(ErrorMessages[ErrorIds.TooHighAccessForSystemStreams], { param: streamId });
    }
  }
  return null;
}

// An id that routes to the account store (any spelling) must be a known
// account stream id; a system-looking id is judged the same way.
function isUnknownSystemStream (streamId: string) {
  const routesToAccount = storeDataUtils.parseStoreIdAndStoreItemId(streamId)[0] === storeDataUtils.AccountStoreId;
  return (routesToAccount || streamId.startsWith(':_system:') || streamId.startsWith(':system:')) &&
            accountStreams.toFieldName(streamId) === streamId;
}

export { validateAccountStreamPermissions };
