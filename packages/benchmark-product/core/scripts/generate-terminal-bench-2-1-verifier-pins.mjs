#!/usr/bin/env node

/**
 * Generates what the product core knows about the verifier of each official Terminal-Bench 2.1
 * task, read from the task packages themselves:
 *
 * - `src/intake/terminal-bench-2-1-verifier-pins.ts`: for each of the 89 tasks, the verifier
 *   timeout and the image reference its `task.toml` declares, and the name and SHA-256 of every
 *   file under its `tests/` directory. `src/intake/terminal-bench-2-1.ts` seals one
 *   `external-verifier` EvaluationSpec per task from these values and nothing else.
 * - `test/fixtures/terminal-bench-2-1-packages/manifest.json`: the path and SHA-256 of every file
 *   of every package. Digests only. No package bytes are committed: a `task.toml` carries its
 *   authors' names and email addresses.
 *
 * It needs the 89 packages, which a developer downloads from Harbor's registry. CI never runs it.
 * What CI runs is `src/intake/terminal-bench-2-1-verifier-pins.test.ts`, which rebuilds the chain
 * from the two committed files alone: each package's manifest lines hash, by Harbor's rule, to the
 * package ref the slate pins, and each task's pinned test material is that manifest's `tests/`
 * lines.
 *
 * The packages are the ones Harbor publishes for the dataset revision the slate pins. With
 * Harbor 0.21.0:
 *
 *     harbor download "terminal-bench/terminal-bench-2-1@<dataset revision>" -o <dir> --export
 *
 * writes `<dir>/terminal-bench-2-1/<task name>/`, and that directory is this script's input. The
 * script prints the exact command when it is run with no argument. Where the bytes came from is
 * not trusted: for each package the script refuses to write anything unless
 *
 * - every file of the package directory hashes, by Harbor's content-hash rule, to the package ref
 *   the slate pins (`src/intake/terminal-bench-2-1-slate.ts`);
 * - `[task] name` in `task.toml` is `terminal-bench/<name>`;
 * - `[verifier] timeout_sec` is a whole number of seconds, and `[environment] docker_image` is a
 *   plain string;
 * - `tests/test.sh` writes the reward in one place and in one way: `1` to
 *   `/logs/verifier/reward.txt` when every exit code it checks is zero and `0` otherwise, and no
 *   other file under `tests/`, `environment/`, `solution/` or `steps/` names a reward file.
 *
 * The last assertion is the source of the sealed verdict rule's threshold. Each spec passes at a
 * reward of 1 and fails at 0 because every one of the 89 verifier scripts writes exactly those two
 * values. That is a fact about the packages, checked here on every run.
 *
 * The published packages, not the dataset's upstream git repository, are the input, because the
 * two are not the same bytes. The commit the slate names is where the task list was read. A
 * package's bytes are identified by its slate ref, the content hash Harbor gives the published
 * package. When this table was first generated, 88 of the 89 task directories at that commit held
 * exactly the files of the published package, once the `.gitignore` each directory carries in the
 * repository, which Harbor does not publish, was left out, and the repository's own
 * `tasks/dataset.toml` listed the slate ref for each of them. The 89th, `sanitize-git-repo`, did
 * not: its `tests/test_outputs.py` writes five placeholder credentials as two joined string
 * literals in the repository and as one literal each in the published package, and the
 * repository lists another ref for it. The slate ref names the published package, which is what
 * Harbor runs and what a trial records.
 *
 * Run `yarn build` first: the slate table is read from `dist/`.
 *
 * Usage:
 *   node scripts/generate-terminal-bench-2-1-verifier-pins.mjs --packages <dir>/terminal-bench-2-1
 */

import { createHash } from "node:crypto";
import { lstatSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { compareCodePointStrings, harborPackageContentHash } from "@jinn-network/task-execution-profiles";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const pinsPath = join(packageRoot, "src", "intake", "terminal-bench-2-1-verifier-pins.ts");
const manifestPath = join(packageRoot, "test", "fixtures", "terminal-bench-2-1-packages", "manifest.json");

const REWARD_FILE = "/logs/verifier/reward.txt";
/** Directories whose files run, as opposed to the prose in `README.md` and `instruction.md`. */
const EXECUTED_DIRECTORIES = ["tests/", "environment/", "solution/", "steps/"];

function fail(message) {
  throw new Error(message);
}

async function loadBuilt(relativePath) {
  const path = join(packageRoot, "dist", relativePath);
  try {
    return await import(pathToFileURL(path).href);
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    fail(`cannot import ${path}. Run "yarn build" first.\n${detail}`);
  }
}

/** Every file of a package directory, as its path from the package root with `/` between
 * segments, and its bytes. Anything that is not a regular file or a directory is refused: Harbor
 * hashes file bytes. */
function packageFiles(packageDir) {
  const files = [];
  const walk = (directory, prefix) => {
    for (const name of readdirSync(directory)) {
      const path = join(directory, name);
      const relative = `${prefix}${name}`;
      const stat = lstatSync(path);
      if (stat.isDirectory()) walk(path, `${relative}/`);
      else if (stat.isFile()) files.push({ path: relative, bytes: readFileSync(path) });
      else fail(`${path} is neither a regular file nor a directory; a task package holds files only`);
    }
  };
  walk(packageDir, "");
  return files;
}

/**
 * The three values read from `task.toml`. This is not a TOML parser. It follows table headers and
 * takes three keys, each of which must appear exactly once in the one form the 89 packages use,
 * and it refuses a file that holds a multi-line string, where a line could pass for a header.
 */
function readTaskToml(text, at) {
  if (text.includes('"""') || text.includes("'''") || text.includes("\r")) {
    fail(`${at}: holds a multi-line string or a carriage return, which this reader does not follow`);
  }
  const wanted = new Map([["task.name", []], ["verifier.timeout_sec", []], ["environment.docker_image", []]]);
  let table = "";
  for (const line of text.split("\n")) {
    const header = /^\s*\[\[?\s*([A-Za-z0-9_.-]+)\s*\]\]?\s*(?:#.*)?$/u.exec(line);
    if (header !== null) {
      table = header[1];
      continue;
    }
    const pair = /^\s*([A-Za-z0-9_-]+)\s*=\s*(.*?)\s*$/u.exec(line);
    if (pair !== null) wanted.get(`${table}.${pair[1]}`)?.push(pair[2]);
  }
  const one = (key) => {
    const values = wanted.get(key);
    if (values.length !== 1) fail(`${at}: expected ${key} exactly once, found it ${values.length} times`);
    return values[0];
  };
  const plainString = (key) => {
    const match = /^"([^"\\]+)"$/u.exec(one(key));
    if (match === null) fail(`${at}: ${key} is not a plain double-quoted string: ${one(key)}`);
    return match[1];
  };
  const timeout = /^([1-9][0-9]*)(?:\.0+)?$/u.exec(one("verifier.timeout_sec"));
  if (timeout === null) fail(`${at}: verifier.timeout_sec is not a whole number of seconds: ${one("verifier.timeout_sec")}`);
  return {
    taskName: plainString("task.name"),
    timeoutSec: Number(timeout[1]),
    declaredImage: plainString("environment.docker_image"),
  };
}

/**
 * `tests/test.sh` mentions a reward in exactly one block, which writes 1 when every exit code it
 * checks is zero and 0 otherwise:
 *
 *     if [ $? -eq 0 ]; then
 *       echo 1 > /logs/verifier/reward.txt
 *     else
 *       echo 0 > /logs/verifier/reward.txt
 *     fi
 *
 * The condition is one or more tests of the form `[ $<exit code> -eq 0 ]`, joined by `&&`: `$?`,
 * the exit code of the command before it, or a variable the script saved one in.
 */
const EXIT_CODE_IS_ZERO = String.raw`\[ \$(?:\?|[A-Za-z_][A-Za-z0-9_]*) -eq 0 \]`;
const REWARD_CONDITION = new RegExp(`^if ${EXIT_CODE_IS_ZERO}(?: && ${EXIT_CODE_IS_ZERO})*; then$`, "u");

function assertRewardBlock(script, at) {
  const lines = script.split("\n").map((line) => line.trim());
  const mentions = lines.flatMap((line, index) => (line.toLowerCase().includes("reward") ? [index] : []));
  if (mentions.length !== 2) fail(`${at}: expected two lines that mention a reward, found ${mentions.length}`);
  const [pass, otherwise] = mentions;
  const block = lines.slice(pass - 1, pass + 4);
  const expected = [`echo 1 > ${REWARD_FILE}`, "else", `echo 0 > ${REWARD_FILE}`, "fi"];
  if (
    otherwise !== pass + 2
    || !REWARD_CONDITION.test(block[0] ?? "")
    || expected.some((line, offset) => block[offset + 1] !== line)
  ) {
    fail(`${at}: the reward is not written by one if/else block, on exit codes equal to 0, that writes 1 or 0 to ${REWARD_FILE}`);
  }
}

function readPackage(packagesDir, task) {
  const at = join(packagesDir, task.name);
  const files = packageFiles(at)
    .map((file) => ({ ...file, sha256: createHash("sha256").update(file.bytes).digest("hex") }))
    .sort((left, right) => compareCodePointStrings(left.path, right.path));

  const contentHash = harborPackageContentHash(files.map(({ path, sha256 }) => ({ path, sha256 })));
  if (`sha256:${contentHash}` !== task.ref) {
    fail(`${at}: Harbor's content hash of the package is sha256:${contentHash}, and the slate pins ${task.ref}`);
  }

  const bytesOf = (path) => files.find((file) => file.path === path)?.bytes ?? fail(`${at}: the package has no ${path}`);
  const toml = readTaskToml(bytesOf("task.toml").toString("utf8"), `${at}/task.toml`);
  if (toml.taskName !== `${task.org}/${task.name}`) {
    fail(`${at}/task.toml: [task] name is ${JSON.stringify(toml.taskName)}, not ${JSON.stringify(`${task.org}/${task.name}`)}`);
  }

  assertRewardBlock(bytesOf("tests/test.sh").toString("utf8"), `${at}/tests/test.sh`);
  for (const file of files) {
    if (file.path === "tests/test.sh" || !EXECUTED_DIRECTORIES.some((directory) => file.path.startsWith(directory))) continue;
    // latin1 keeps every byte, so a binary file is searched as it is.
    const text = file.bytes.toString("latin1");
    if (text.includes("reward.txt") || text.includes("reward.json")) {
      fail(`${at}/${file.path}: names a reward file; only tests/test.sh may write the reward`);
    }
  }

  const testMaterial = files.filter((file) => file.path.startsWith("tests/")).map(({ path, sha256 }) => ({ name: path, sha256 }));
  return {
    manifest: { name: task.name, ref: task.ref, files: files.map(({ path, sha256 }) => ({ path, sha256 })) },
    pin: { name: task.name, timeoutSec: toml.timeoutSec, declaredImage: toml.declaredImage, testMaterial },
  };
}

function renderPins(pins) {
  const lines = [
    "// SPDX-License-Identifier: Apache-2.0",
    "",
    "/**",
    " * What each official Terminal-Bench 2.1 task package declares about its own verifier.",
    " *",
    " * GENERATED by `packages/benchmark-product/core/scripts/generate-terminal-bench-2-1-verifier-pins.mjs`",
    " * from the 89 task packages Harbor publishes for the dataset revision the slate pins. Do not edit",
    " * by hand. The generator is never run in CI; `terminal-bench-2-1-verifier-pins.test.ts` holds",
    " * this table to the committed package manifest, and that manifest to the slate's package refs.",
    " *",
    " * For each task, in slate order: `timeoutSec` is `[verifier] timeout_sec` of the package's",
    " * `task.toml`, `declaredImage` is its `[environment] docker_image` character for character (a tag,",
    " * not a pinned image), and `testMaterial` is every file under the package's `tests/` directory,",
    " * ascending by Unicode code point, with the SHA-256 of its bytes.",
    " */",
    "export const TERMINAL_BENCH_21_VERIFIER_PINS = [",
  ];
  for (const pin of pins) {
    lines.push(
      "  {",
      `    name: ${JSON.stringify(pin.name)},`,
      `    timeoutSec: ${pin.timeoutSec},`,
      `    declaredImage: ${JSON.stringify(pin.declaredImage)},`,
      "    testMaterial: [",
      ...pin.testMaterial.map((file) => `      { name: ${JSON.stringify(file.name)}, sha256: ${JSON.stringify(file.sha256)} },`),
      "    ],",
      "  },",
    );
  }
  lines.push("] as const;", "");
  return lines.join("\n");
}

/** One file per line, so a change to one digest is a one-line diff. */
function renderManifest({ datasetId, datasetRevision, packages }) {
  const lines = [
    "{",
    '  "description": "The path and SHA-256 of every file of every official Terminal-Bench 2.1 task package, as Harbor publishes it for the dataset revision below. Digests only: no package bytes are committed. Written by scripts/generate-terminal-bench-2-1-verifier-pins.mjs.",',
    `  "datasetId": ${JSON.stringify(datasetId)},`,
    `  "datasetRevision": ${JSON.stringify(datasetRevision)},`,
    '  "packages": [',
  ];
  packages.forEach((entry, packageIndex) => {
    lines.push(
      "    {",
      `      "name": ${JSON.stringify(entry.name)},`,
      `      "ref": ${JSON.stringify(entry.ref)},`,
      '      "files": [',
    );
    entry.files.forEach((file, fileIndex) => {
      const comma = fileIndex === entry.files.length - 1 ? "" : ",";
      lines.push(`        { "path": ${JSON.stringify(file.path)}, "sha256": ${JSON.stringify(file.sha256)} }${comma}`);
    });
    lines.push("      ]", `    }${packageIndex === packages.length - 1 ? "" : ","}`);
  });
  lines.push("  ]", "}", "");
  return lines.join("\n");
}

async function main() {
  const slate = await loadBuilt("intake/terminal-bench-2-1-slate.js");
  const dataset = await loadBuilt("runtime/terminal-bench-2-1/manifest.js");
  const datasetId = dataset.TERMINAL_BENCH_2_1_DATASET_ID;
  const datasetRevision = dataset.TERMINAL_BENCH_2_1_DATASET_REF;

  const flag = process.argv.indexOf("--packages");
  const packagesDir = flag === -1 ? undefined : process.argv[flag + 1];
  if (packagesDir === undefined) {
    fail(
      "pass the directory that holds the 89 task packages:\n"
      + "  node scripts/generate-terminal-bench-2-1-verifier-pins.mjs --packages <dir>/terminal-bench-2-1\n"
      + "Harbor 0.21.0 writes that directory with:\n"
      + `  harbor download "${datasetId}@${datasetRevision}" -o <dir> --export`,
    );
  }

  const read = slate.TERMINAL_BENCH_21_OFFICIAL_TASKS.map((task) => readPackage(packagesDir, task));
  const fileCount = read.reduce((count, entry) => count + entry.manifest.files.length, 0);
  mkdirSync(dirname(manifestPath), { recursive: true });
  writeFileSync(manifestPath, renderManifest({ datasetId, datasetRevision, packages: read.map((entry) => entry.manifest) }));
  writeFileSync(pinsPath, renderPins(read.map((entry) => entry.pin)));
  console.log(`read ${read.length} packages (${fileCount} files): every content hash equals its slate ref.`);
  console.log(`wrote ${manifestPath}`);
  console.log(`wrote ${pinsPath}`);
}

main().catch((cause) => {
  console.error(cause instanceof Error ? cause.message : String(cause));
  process.exit(1);
});
