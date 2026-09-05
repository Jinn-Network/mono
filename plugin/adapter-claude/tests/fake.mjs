// SPDX-License-Identifier: Apache-2.0

import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { SESSION_BIN_NAME } from "../src/runtime.mjs";
import { temp } from "./helpers.mjs";

const FAKE = fileURLToPath(new URL("./fake-runtime.mjs", import.meta.url));

/** A directory holding an executable named exactly what the real resolver looks for. */
export function fakeRuntimeDir() {
  const directory = temp("jinn-claude-bin-");
  const shim = join(directory, SESSION_BIN_NAME);
  writeFileSync(shim, `#!/bin/sh\nexec "${process.execPath}" "${FAKE}" "$@"\n`);
  chmodSync(shim, 0o755);
  return directory;
}

/**
 * An environment in which the adapter resolves the fake runtime and keeps every byte it
 * writes inside one temporary Claude home.
 */
export function fakeEnv(overrides = {}) {
  const home = temp("jinn-claude-home-");
  mkdirSync(home, { recursive: true });
  return {
    CLAUDE_CONFIG_DIR: home,
    PATH: fakeRuntimeDir(),
    ANTHROPIC_MODEL: "claude-opus-5",
    CLAUDE_CODE_EXECPATH: "/opt/claude/versions/2.1.258",
    ...overrides,
  };
}

/** The tool calls the fake runtime saw, in order. */
export function toolCalls(env) {
  try {
    return JSON.parse(readFileSync(join(env.CLAUDE_CONFIG_DIR, "jinn", "runtime-home", "calls.json"), "utf8"));
  } catch {
    return [];
  }
}
