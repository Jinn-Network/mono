// SPDX-License-Identifier: Apache-2.0

import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";

export function temp(prefix = "jinn-claude-") {
  return mkdtempSync(join(tmpdir(), prefix));
}

export function stdinOf(payload) {
  return Readable.from([Buffer.from(JSON.stringify(payload), "utf8")]);
}

export function feedEvents(path) {
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => JSON.parse(line));
}
