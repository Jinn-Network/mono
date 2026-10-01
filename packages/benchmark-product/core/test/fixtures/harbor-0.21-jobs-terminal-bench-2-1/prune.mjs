#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0

/**
 * Prunes a real Harbor 0.21 jobs directory down to the committed fixture in `./jobs`.
 *
 *   node prune.mjs <source-jobs-dir> [<out-dir>]
 *
 * The source is a jobs directory Harbor wrote (`harbor run ... -o jobs`), holding one job
 * directory per arm. The output keeps, for each job, the job `config.json`, `lock.json` and
 * `result.json`, and for each kept task the trial `config.json`, `result.json` and
 * `verifier/reward.txt`. Everything else a trial directory holds is left behind: trajectories,
 * terminal recordings, agent logs and verifier output carry task instructions, reference
 * solutions and hidden test output.
 *
 * Two fields are removed from each trial `result.json`, by deleting their line and nothing else,
 * so every other byte is what Harbor wrote:
 *   - `trial_uri`, an absolute path on the machine that ran Harbor;
 *   - `exception_info.exception_traceback`, a stack trace full of install paths.
 *
 * The script then refuses to finish if anything it wrote could hold a secret or a host path. It
 * is deliberately strict: a failure here means look at the record, not loosen the check.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";

const JOBS = ["oracle", "terminus-2"];
const TASKS = ["adaptive-rejection-sampler", "cancel-async-tasks", "chess-best-move"];
const JOB_FILES = ["config.json", "lock.json", "result.json"];

const here = dirname(fileURLToPath(import.meta.url));
const [sourceArg, outArg] = process.argv.slice(2);
if (sourceArg === undefined) {
  console.error("usage: node prune.mjs <source-jobs-dir> [<out-dir>]");
  process.exit(2);
}
const source = resolve(sourceArg);
const out = resolve(outArg ?? join(here, "jobs"));

function fail(message) {
  console.error(`prune: ${message}`);
  process.exit(1);
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

/** Deletes the single line holding `"<key>": "<string>"` and proves nothing else changed. */
function dropStringLine(text, key, withoutKey) {
  const line = new RegExp(`^[ \\t]*"${key}": "(?:[^"\\\\]|\\\\.)*",\\n`, "mu");
  const matches = text.match(new RegExp(line.source, "gmu")) ?? [];
  if (matches.length !== 1) fail(`expected exactly one "${key}" line, found ${matches.length}`);
  const next = text.replace(line, "");
  if (!isDeepStrictEqual(JSON.parse(next), withoutKey(JSON.parse(text)))) {
    fail(`removing "${key}" changed more than that field`);
  }
  return next;
}

function scrubTrialResult(text) {
  let next = dropStringLine(text, "trial_uri", (value) => {
    delete value.trial_uri;
    return value;
  });
  if (JSON.parse(next).exception_info?.exception_traceback !== undefined) {
    next = dropStringLine(next, "exception_traceback", (value) => {
      delete value.exception_info.exception_traceback;
      return value;
    });
  }
  return next;
}

const FORBIDDEN_KEY = /api[_-]?key|secret|password|passwd|authorization|credential|bearer|access[_-]?token|auth[_-]?token/iu;
const MUST_BE_EMPTY = new Set(["env", "kwargs", "mcp_servers", "headers"]);
const FORBIDDEN_TEXT = [
  [/sk-[A-Za-z0-9_-]{6,}/u, "a key-shaped string"],
  [/bearer\s+\S/iu, "a bearer credential"],
  [/[a-z][a-z0-9+.-]*:\/\/[^/\s"]*@/iu, "a URL carrying credentials"],
  [/file:\/\//iu, "a file URL"],
  [/(?:^|[\s"'=:(,])\/(?:root|home|Users|opt|usr|var|tmp|etc|private|mnt|workspace|app)\b/u, "an absolute host path"],
  [/Traceback \(most recent call last\)/u, "a traceback"],
];

function guardValue(value, where) {
  if (typeof value === "string") {
    if (value.startsWith("/")) fail(`${where} is an absolute path`);
    for (const [pattern, what] of FORBIDDEN_TEXT) {
      if (pattern.test(value)) fail(`${where} holds ${what}`);
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((entry, index) => guardValue(entry, `${where}[${index}]`));
    return;
  }
  if (typeof value === "object" && value !== null) {
    for (const [key, entry] of Object.entries(value)) {
      if (FORBIDDEN_KEY.test(key)) fail(`${where}.${key} is a credential-shaped key`);
      if (MUST_BE_EMPTY.has(key) && entry !== null && Object.keys(entry).length > 0) {
        fail(`${where}.${key} is not empty`);
      }
      guardValue(entry, `${where}.${key}`);
    }
  }
}

function writeChecked(relative, text) {
  for (const [pattern, what] of FORBIDDEN_TEXT) {
    if (pattern.test(text)) fail(`${relative} holds ${what}`);
  }
  if (relative.endsWith(".json")) guardValue(JSON.parse(text), relative);
  const target = join(out, relative);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, text);
}

function taskOf(trialDir) {
  const config = join(trialDir, "config.json");
  if (!existsSync(config)) return undefined;
  const name = readJson(config).task?.name;
  return typeof name === "string" ? name.slice(name.lastIndexOf("/") + 1) : undefined;
}

rmSync(out, { recursive: true, force: true });
let trials = 0;
for (const job of JOBS) {
  const jobDir = join(source, job);
  if (!existsSync(jobDir)) fail(`source has no job directory ${job}`);
  for (const file of JOB_FILES) {
    writeChecked(join(job, file), readFileSync(join(jobDir, file), "utf8"));
  }
  const kept = new Set();
  for (const entry of readdirSync(jobDir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
    if (!entry.isDirectory()) continue;
    const task = taskOf(join(jobDir, entry.name));
    if (task === undefined || !TASKS.includes(task)) continue;
    if (kept.has(task)) fail(`job ${job} has more than one trial for ${task}`);
    kept.add(task);
    const trial = join(job, entry.name);
    writeChecked(join(trial, "config.json"), readFileSync(join(jobDir, entry.name, "config.json"), "utf8"));
    writeChecked(join(trial, "result.json"), scrubTrialResult(readFileSync(join(jobDir, entry.name, "result.json"), "utf8")));
    writeChecked(
      join(trial, "verifier", "reward.txt"),
      readFileSync(join(jobDir, entry.name, "verifier", "reward.txt"), "utf8"),
    );
    trials += 1;
  }
  if (kept.size !== TASKS.length) fail(`job ${job} is missing a trial for one of ${TASKS.join(", ")}`);
}

console.log(`pruned ${trials} trials across ${JOBS.length} jobs into ${out}`);
