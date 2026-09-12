// SPDX-License-Identifier: Apache-2.0

/**
 * Where the adapter's state lives.
 *
 * One rule governs the whole module: every path is derived from the Claude Code home in
 * effect, so two homes on one machine never share an archive, an index, or a capture
 * directory. `CLAUDE_CONFIG_DIR` is the profile switch Claude Code itself uses.
 */

import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** The active Claude Code home. */
export function claudeHome(env = process.env) {
  const value = (env.CLAUDE_CONFIG_DIR ?? "").trim();
  return value === "" ? resolve(homedir(), ".claude") : resolve(value);
}

/** Adapter-owned state: per-session markers. Never the runtime's data. */
export function stateDir(env = process.env) {
  return join(claudeHome(env), "jinn");
}

/** `JINN_PLUGIN_HOME` for every runtime instance this adapter is responsible for. */
export function runtimeHome(env = process.env) {
  return join(stateDir(env), "runtime-home");
}

/** This plugin's own directory: the clone root when installed. */
export function pluginDir() {
  return resolve(dirname(fileURLToPath(import.meta.url)), "..");
}
