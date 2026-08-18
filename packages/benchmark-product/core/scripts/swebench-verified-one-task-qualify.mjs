#!/usr/bin/env node
/**
 * Fail-closed operator qualify for SWE-bench Verified one_task on the HuggingFace pin.
 * Default `yarn test` does not run this. It never downloads the dataset or Verified images.
 *
 * See docs/runbooks/swebench-verified-official-one-task.md.
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const colophonBin = join(packageRoot, "dist", "cli", "bin.js");
const draftId = "sbv-one";

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(2);
}

if (process.env.COLOPHON_SWEBENCH_VERIFIED_ONE_TASK_QUALIFY !== "1") {
  fail("Refusing: set COLOPHON_SWEBENCH_VERIFIED_ONE_TASK_QUALIFY=1 and supply operator paths. See docs/runbooks/swebench-verified-official-one-task.md. This script never downloads SWE-bench Verified.");
}

const {
  SWE_BENCH_VERIFIED_DATASET_REVISION,
  SWE_BENCH_VERIFIED_SUBMIT_CLOSED_SENTENCE,
  namedSliceTaskNames,
} = await import("../dist/index.js");

function requiredEnv(name) {
  const value = process.env[name]?.trim();
  if (value === undefined || value === "") fail(`set ${name} to an existing operator path`);
  return value;
}

function run(command, argv) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, argv, {
      cwd: packageRoot,
      env: { ...process.env },
      stdio: ["ignore", "pipe", "inherit"],
    });
    const stdout = [];
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.once("error", reject);
    child.once("exit", (code) => {
      const out = Buffer.concat(stdout).toString("utf8");
      if (code === 0) resolve(out);
      else reject(new Error(`${command} ${argv.join(" ")} exited ${code}\n${out}`));
    });
  });
}

function colophon(args) {
  return run(process.execPath, [colophonBin, ...args]);
}

function parseEnvelope(stdout) {
  const parsed = JSON.parse(stdout);
  if (parsed.ok !== true) throw new Error(`Colophon refused: ${stdout}`);
  return parsed.result;
}

if (!existsSync(colophonBin)) fail("build the core package first: yarn --cwd packages/benchmark-product/core build");

const python = realpathSync(requiredEnv("COLOPHON_SWEBENCH_PYTHON"));
const registryMetadataPath = realpathSync(requiredEnv("COLOPHON_SWEBENCH_REGISTRY_METADATA"));
const workspace = process.env.COLOPHON_SWEBENCH_WORKSPACE?.trim() || "/tmp/colophon-swebench-verified-one-task";
if (existsSync(join(workspace, "workspace.json"))) fail(`${workspace} is already a Colophon workspace; pick a new COLOPHON_SWEBENCH_WORKSPACE`);

const versionOut = (await run(python, ["-c", "import swebench; print(swebench.__version__)"])).trim();
if (!/^4\.1\.\d+/u.test(versionOut)) fail(`swebench must be 4.1.x, got ${versionOut}`);

const metadata = JSON.parse(readFileSync(registryMetadataPath, "utf8"));
if (metadata.revision !== SWE_BENCH_VERIFIED_DATASET_REVISION) {
  fail(`registry revision ${metadata.revision} is not the sealed pin ${SWE_BENCH_VERIFIED_DATASET_REVISION}`);
}
const one = namedSliceTaskNames(metadata.instance_ids, "one_task");
if (one.length !== 1) fail("named one_task slice must be exactly one instance id");

mkdirSync(workspace, { recursive: true });
const common = ["--workspace", workspace, "--principal", "sponsor-1"];
parseEnvelope(await colophon(["init", ...common, "--json"]));
parseEnvelope(await colophon(["draft", "create", ...common, "--id", draftId, "--name", draftId, "--json"]));
parseEnvelope(await colophon(["arm", "add", ...common, "--draft", draftId, "--arm", "one", "--pinning", JSON.stringify({ harness: { id: "placeholder", version: "1" } }), "--json"]));

const selectionPath = join(workspace, "selection.json");
writeFileSync(selectionPath, JSON.stringify({
  executable: python,
  registryMetadataPath,
  coverage: "one_task",
  arms: [{ armId: "one", modelNameOrPath: "one" }],
}, null, 2));
parseEnvelope(await colophon(["runtime", "swe-bench-verified", "select", ...common, "--draft", draftId, "--file", selectionPath, "--json"]));
const quoted = parseEnvelope(await colophon(["quote", ...common, "--draft", draftId, "--json"]));
if (quoted.presentation?.suite?.coverage !== "one_task") fail(`expected one_task, got ${quoted.presentation?.suite?.coverage}`);
if (quoted.presentation?.suite?.executionConformance !== true) fail("expected executionConformance true");
if (quoted.presentation?.suite?.leaderboardSubmitReady !== false) fail("one_task must not be leaderboardSubmitReady");
parseEnvelope(await colophon(["lock", ...common, "--draft", draftId, "--json"]));
const exported = parseEnvelope(await colophon(["swebench", "export", ...common, "--draft", draftId, "--arm", "one", "--json"]));
if (exported.mode !== "inspection-upload") fail(`expected inspection-upload, got ${exported.mode}`);
if (!String(exported.instructions).includes(SWE_BENCH_VERIFIED_SUBMIT_CLOSED_SENTENCE)) {
  fail("export instructions must say Colophon does not place the swebench.com row");
}
process.stdout.write(`ok one_task=${one[0]} conforming not-ready\n`);
