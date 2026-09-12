// SPDX-License-Identifier: Apache-2.0

/**
 * Resolve the pinned runtime. **Resolve only, never acquire.**
 *
 * The Hermes adapter installs its runtime at plugin-register time; Claude Code has no such
 * hook, and a hook that ran `npm install` would turn a session start into a several-minute
 * hang. So a missing runtime is silence plus one doctor line naming the command that fixes
 * it, never a blocked session.
 *
 * Resolution order is the pinned plugin-local artifact, then `JINN_PLUGIN_RUNTIME_BIN`, then
 * the command on `PATH`. The last two are development overrides and are reported as such, so
 * a doctor never tells an operator their product install is fine when it is really an export.
 */

import { accessSync, constants, readFileSync, statSync } from "node:fs";
import { delimiter, dirname, isAbsolute, join, normalize } from "node:path";

import { pluginDir } from "./paths.mjs";

export const RUNTIME_PACKAGE = "@jinn-network/plugin-runtime";
export const SESSION_BIN_NAME = "jinn-plugin-runtime-session";

const EXACT_SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u;

/** The three-key pin manifest, or `undefined` when it is missing or malformed. */
export function readPin(directory = pluginDir()) {
  let document;
  try {
    document = JSON.parse(readFileSync(join(directory, "runtime-pin.json"), "utf8"));
  } catch {
    return undefined;
  }
  if (document === null || typeof document !== "object" || Array.isArray(document)) {
    return undefined;
  }
  const { package: pkg, version, bin } = document;
  if (pkg !== RUNTIME_PACKAGE) return undefined;
  if (typeof version !== "string" || !EXACT_SEMVER.test(version)) return undefined;
  if (typeof bin !== "string" || bin === "" || isAbsolute(bin)) return undefined;
  // A pin that escapes the plugin directory would make the manifest a path primitive.
  if (normalize(bin).split(/[\\/]/u).includes("..")) return undefined;
  return { package: pkg, version, bin };
}

function isExecutableFile(path) {
  try {
    if (!statSync(path).isFile()) return false;
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function onPath(name, env) {
  for (const directory of String(env.PATH ?? "").split(delimiter)) {
    if (directory === "") continue;
    const candidate = join(directory, name);
    if (isExecutableFile(candidate)) return candidate;
  }
  return undefined;
}

/**
 * The argv for the session-role host composition entry — the one that loads the local capture
 * signer, which the tools-role entry deliberately does not (F-C4-T13-2).
 *
 * @returns {{argv: string[], source: string, detail: string, pin?: object} | undefined}
 */
export function resolveSessionRuntime(env = process.env, directory = pluginDir()) {
  const pin = readPin(directory);
  if (pin !== undefined) {
    const binary = join(directory, pin.bin);
    if (isExecutableFile(binary)) {
      return {
        argv: [binary],
        source: "pinned",
        detail: `${pin.package}@${pin.version}`,
        pin,
      };
    }
  }

  const override = String(env.JINN_PLUGIN_RUNTIME_BIN ?? "").trim();
  if (override !== "" && isExecutableFile(override)) {
    const sibling = join(dirname(override), SESSION_BIN_NAME);
    return isExecutableFile(sibling)
      ? { argv: [sibling], source: "env", detail: "JINN_PLUGIN_RUNTIME_BIN (session sibling)" }
      : {
          argv: [override, "serve", "--role", "session"],
          source: "env",
          detail: "JINN_PLUGIN_RUNTIME_BIN",
        };
  }

  const found = onPath(SESSION_BIN_NAME, env);
  if (found !== undefined) {
    return { argv: [found], source: "path", detail: `${SESSION_BIN_NAME} on PATH` };
  }
  return undefined;
}
