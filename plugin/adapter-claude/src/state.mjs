// SPDX-License-Identifier: Apache-2.0

/**
 * Per-session adapter state, carried on disk because each Claude Code hook is its own
 * process. One property is load-bearing: the file is named by the **digest** of the host's
 * session id, never by the id itself. A host-controlled string is then not a path component
 * at all, which is a stronger boundary than validating one — there is no shape to get wrong.
 *
 * Nothing here throws. A capture problem must never break the user's session, so every
 * failure is an absent state rather than a raised error.
 */

import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { stateDir } from "./paths.mjs";

/** The state file for one host session. */
export function sessionStatePath(hostSessionId, env = process.env) {
  const digest = createHash("sha256").update(String(hostSessionId), "utf8").digest("hex");
  return join(stateDir(env), "sessions", `${digest.slice(0, 32)}.json`);
}

/** The stored state, or `undefined` when there is none this process can use. */
export function readState(path) {
  let raw;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
  try {
    const parsed = JSON.parse(raw);
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed
      : undefined;
  } catch {
    return undefined;
  }
}

/** Best-effort persist. Owner-only, because the feed path names a private archive. */
export function writeState(path, state) {
  try {
    mkdirSync(join(path, ".."), { recursive: true, mode: 0o700 });
    writeFileSync(path, `${JSON.stringify(state)}\n`, { encoding: "utf8", mode: 0o600 });
    return true;
  } catch {
    return false;
  }
}

/** Drop the state for a finished session. A failure leaves a stale marker, never an error. */
export function clearState(path) {
  try {
    rmSync(path, { force: true });
  } catch {
    // A stale marker costs the next session nothing: it is keyed by that session's own id.
  }
}
