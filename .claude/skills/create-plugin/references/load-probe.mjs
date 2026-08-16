#!/usr/bin/env node
/**
 * create-plugin load probe (AC#4).
 *
 * Drives the real daemon loader against a scaffolded plug-in on disk and
 * reports whether it resolves for its target. This is the skill's "did it
 * actually load" gate — it exercises exactly what the daemon does at boot:
 * `loadSolverPlugins([{ source: 'file:<path>' }])` → `forSolverType(<target>)`.
 *
 * Prerequisite: the client must be BUILT (`cd operator && yarn build`) so the
 * compiled loader exists at `operator/dist/plugins/index.js`. The script
 * resolves the built loader relative to the repo root, not from npm.
 *
 * Usage:
 *   node .claude/skills/create-plugin/references/load-probe.mjs <abs-plugin-path> <target>
 *
 *   <abs-plugin-path>  absolute path to the scaffolded plug-in directory
 *   <target>           the SolverType string (solver-type-plugin), e.g.
 *                      "demo.v1" / "swe-rebench-v2.v1"; or "jinn.runtime"
 *                      for a runtime-plugin.
 *
 * Output: a single JSON line on stdout:
 *   {"ok":true,"resolved":["@you/name"],"target":"demo.v1"}
 * Exit code 0 when ok:true, 1 otherwise.
 */

import { resolve, dirname, join } from 'node:path';
import { existsSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';

const absPath = process.argv[2];
const target = process.argv[3];

function fail(message) {
  console.log(JSON.stringify({ ok: false, error: message }));
  process.exit(1);
}

if (!absPath || !target) {
  fail('usage: load-probe.mjs <abs-plugin-path> <target>');
}

// Resolve the built loader. This file lives at
//   <repo>/.claude/skills/create-plugin/references/load-probe.mjs
// so four levels up is the repo root; the loader is at
//   <repo>/operator/dist/plugins/index.js
const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '../../../../');
const loaderPath = join(repoRoot, 'operator', 'dist', 'plugins', 'index.js');

if (!existsSync(loaderPath)) {
  fail(
    `built loader not found at ${loaderPath} — run \`cd operator && yarn build\` first`,
  );
}

const pluginRoot = resolve(absPath);
if (!existsSync(pluginRoot)) {
  fail(`plugin path not found: ${pluginRoot}`);
}

const { loadSolverPlugins } = await import(pathToFileURL(loaderPath).href);

let reg;
try {
  reg = await loadSolverPlugins([{ source: 'file:' + pluginRoot }]);
} catch (err) {
  fail(err instanceof Error ? err.message : String(err));
}

const matches = reg.forSolverType(target);
const ok = matches.length > 0;
console.log(
  JSON.stringify({ ok, resolved: matches.map((p) => p.name), target }),
);
process.exit(ok ? 0 : 1);
