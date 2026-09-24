#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0

/**
 * The adapter must run from a bare clone. Claude Code installs a plugin by cloning it and runs
 * no dependency install, so a single third-party import would make capture conditional on a
 * step the operator never performs. Every import must therefore be `node:`-prefixed or
 * relative.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const SPECIFIER = /(?:^|\s)(?:import|export)[\s\S]*?from\s+["']([^"']+)["']|import\(\s*["']([^"']+)["']\s*\)/gu;

function sources(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return sources(path);
    return entry.name.endsWith(".mjs") ? [path] : [];
  });
}

const violations = [];
const files = [...sources(join(root, "src")), ...sources(join(root, "scripts"))];
for (const file of files) {
  const text = readFileSync(file, "utf8");
  for (const match of text.matchAll(SPECIFIER)) {
    const specifier = match[1] ?? match[2];
    if (specifier === undefined) continue;
    if (specifier.startsWith("node:") || specifier.startsWith(".")) continue;
    violations.push(`${file.slice(root.length)}: ${specifier}`);
  }
}

if (violations.length > 0) {
  process.stderr.write(`adapter import boundary broken:\n  ${violations.join("\n  ")}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write(`adapter import boundary clean (${files.length} modules)\n`);
}
