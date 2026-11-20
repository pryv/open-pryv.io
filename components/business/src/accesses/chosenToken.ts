/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/**
 * Shortest token a caller may choose for a new access, measured after
 * slugification (what is stored). A token is a bearer credential: a short one
 * can be guessed. A generated token has 25 characters. Checked by
 * `accesses.create` and, for a token an app asks for in its auth request, when
 * `/reg/access` creates the request.
 */
export const MIN_CHOSEN_TOKEN_LENGTH = 16;
