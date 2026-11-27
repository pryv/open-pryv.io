/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/**
 * Boot step of the platform-wide configuration held in the platform store,
 * run by each API process before it serves (after the storages are ready).
 * Nothing to do yet: every key is read from the configuration files and the
 * environment.
 */

type ConfigReader = { get: (key: string) => unknown };
type LoggerLike = { info: (msg: string) => void; warn: (msg: string) => void };

export async function runPlatformConfigBoot (_opts: { config: ConfigReader; logger: LoggerLike }): Promise<void> {
  // nothing yet
}
