// SPDX-License-Identifier: MIT

/**
 * The CLI's library surface — sub-unit C7d.
 *
 * `runCli` is exported so a host that wants the verbs without the process (the client's future
 * `jinn optimize` dispatch, a test, a script) can call them directly. `bin.ts` is the process
 * wrapper and is not re-exported: it runs on import, which is exactly what a library must not do.
 */

export { runCli, USAGE } from "./main.js";
export type { CliContext, CliResult } from "./result.js";
