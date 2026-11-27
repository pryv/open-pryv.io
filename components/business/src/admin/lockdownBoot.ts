/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/**
 * Boot step of the lockdown (`lockdown.ts`), run by each API process before
 * it serves. Nothing to do yet.
 */

type ConfigReader = { get: (key: string) => unknown };
type LoggerLike = { info: (msg: string) => void; warn: (msg: string) => void };

export async function runLockdownBoot (_opts: { config: ConfigReader; logger: LoggerLike }): Promise<void> {
  // nothing yet
}
