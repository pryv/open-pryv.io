/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

// The series engines key a user's HF data by this namespace (the "database"
// of the series connection), not by the user id. Every caller that reads,
// writes, exports, imports or drops a user's series must derive it here, or it
// silently addresses a namespace nobody else uses.
function seriesNamespace (username: string): string {
  return `user.${username}`;
}

export { seriesNamespace };
