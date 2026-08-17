#!/usr/bin/env node
/**
 * Runs the two no-model admission controls for each admitted SkillsBench unit.
 *
 * For every unit: fetch the exact package from the pinned release, resolve its mutable base tag to
 * an immutable digest, build the image, run the upstream oracle, run the upstream verifier, then
 * run the verifier again against a blank workspace. A unit is dynamically eligible only when the
 * oracle reaches the task's canonical full success AND the blank submission does not.
 *
 * No model executes anywhere in this file. The oracle is a shell script the benchmark ships.
 *
 *   node scripts/skillsbench-controls.mjs [--limit N] [--only task-a,task-b]
 *
 * Resumable: results are appended per unit, and a unit already recorded is skipped. Disk-guarded:
 * it refuses to start a unit below the floor and prunes each image after use, because 41 task
 * images do not fit on a laptop.
 */
import { execFileSync, execSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const PACKAGE_ROOT = fileURLToPath(new URL("../", import.meta.url));
const REPO_ROOT = resolve(PACKAGE_ROOT, "../../..");
const FREEZE = resolve(REPO_ROOT, "docs/superpowers/plans/demo-report-1/E1-pre-run-freeze.v4.json");
const OUT = resolve(REPO_ROOT, "docs/superpowers/plans/demo-report-1/E1-control-evidence.v1.json");
const CACHE = resolve(REPO_ROOT, ".skillsbench-cache");
const COMMIT = "b63b7b2850226b6aa4fb5929a8c1ac7bc4d9a6af";
const DISK_FLOOR_GB = Number(process.env.JINN_EVAL_DISK_FLOOR_GB ?? "12");

const argv = process.argv.slice(2);
const option = (name, fallback) => {
  const i = argv.indexOf(name);
  return i === -1 ? fallback : argv[i + 1];
};
const limit = Number(option("--limit", "0"));
const only = (option("--only", "") || "").split(",").filter(Boolean);

function sh(command, options = {}) {
  return execSync(command, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], ...options });
}

function freeGb() {
  const line = sh("df -k / | tail -1").trim().split(/\s+/u);
  return Number(line[3]) / 1024 / 1024;
}

function gitBlobId(bytes) {
  return createHash("sha1").update(`blob ${bytes.length}\0`, "utf8").update(bytes).digest("hex");
}

/** Fetches one blob by Git object id and refuses any byte stream that does not hash back. */
function blob(id) {
  mkdirSync(CACHE, { recursive: true });
  const cached = join(CACHE, id);
  if (existsSync(cached)) {
    const bytes = readFileSync(cached);
    if (gitBlobId(bytes) !== id) throw new Error(`cached blob ${id} does not hash back`);
    return bytes;
  }
  const raw = execFileSync("gh", ["api", `repos/benchflow-ai/skillsbench/git/blobs/${id}`, "--jq", ".content"], {
    encoding: "utf8", maxBuffer: 64 * 1024 * 1024,
  });
  const bytes = Buffer.from(raw.trim(), "base64");
  if (gitBlobId(bytes) !== id) throw new Error(`blob ${id} does not match its declared Git object id`);
  writeFileSync(cached, bytes);
  return bytes;
}

function tree() {
  const cached = join(CACHE, `tree-${COMMIT}.json`);
  if (existsSync(cached)) return JSON.parse(readFileSync(cached, "utf8"));
  const raw = execFileSync("gh", [
    "api", "repos/benchflow-ai/skillsbench/git/trees/dc144e1357083d9c2cebf3056944fa2c2354770b?recursive=1",
  ], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  const body = JSON.parse(raw);
  if (body.truncated) throw new Error("tree truncated; cannot authenticate the roster");
  mkdirSync(CACHE, { recursive: true });
  writeFileSync(cached, JSON.stringify(body));
  return body;
}

function materialize(taskId, entries) {
  const dir = mkdtempSync(join(tmpdir(), `sb-${taskId}-`));
  for (const entry of entries) {
    const rel = entry.path.slice(taskId.length + 1);
    const target = join(dir, ...rel.split("/"));
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, blob(entry.sha), { mode: entry.mode === "100755" ? 0o755 : 0o644 });
  }
  return dir;
}

/** Replaces the Dockerfile's mutable base tag with an immutable digest. */
function pinBase(dir) {
  const path = join(dir, "environment", "Dockerfile");
  const text = readFileSync(path, "utf8");
  const from = /^FROM\s+(.+)$/mu.exec(text);
  if (from === null) throw new Error("Dockerfile has no FROM");
  // `FROM` may carry flags — `FROM --platform=linux/amd64 ubuntu:20.04` appears in the roster. The
  // image reference is the first non-flag token; taking `\S+` blindly pulls the flag instead and
  // rejects a perfectly good unit on what looks like a Docker usage error.
  const tokens = from[1].trim().split(/\s+/u);
  const referenceIndex = tokens.findIndex((token) => !token.startsWith("--"));
  const reference = tokens[referenceIndex];
  if (reference.includes("@sha256:")) return { pinned: reference, text };
  sh(`docker pull -q ${reference}`);
  const digest = sh(`docker inspect --format '{{index .RepoDigests 0}}' ${reference}`).trim();
  // Pin the reference but keep the flags: dropping `--platform` silently changes the architecture.
  const pinnedTokens = [...tokens];
  pinnedTokens[referenceIndex] = digest;
  const pinnedText = text.replace(/^FROM\s+.+$/mu, `FROM ${pinnedTokens.join(" ")}`);
  writeFileSync(join(dir, "environment", "Dockerfile.pinned"), pinnedText);
  return { pinned: digest, text: pinnedText };
}

function readReward(output) {
  const match = /REWARD=(\S+)/u.exec(output);
  return match === null ? null : match[1];
}

const freeze = JSON.parse(readFileSync(FREEZE, "utf8"));
if (freeze.derived.status !== "ready") throw new Error(`freeze is ${freeze.derived.status}; controls are not authorized`);
const admitted = freeze.inputs.admission.verdicts.filter((v) => v.staticallyEligible).map((v) => v.taskId);
const networkOf = new Map(
  freeze.inputs.admission.verdicts.map((v) => [v.taskId, v.checks.runtimeIsolationSatisfiable.detail]),
);

const results = existsSync(OUT) ? JSON.parse(readFileSync(OUT, "utf8")) : { schema: "jinn.demo1.control-evidence.v1", source: { commit: COMMIT }, units: {} };
const byTask = new Map();
for (const entry of tree().tree) {
  if (entry.type !== "blob") continue;
  const task = entry.path.split("/")[0];
  byTask.set(task, [...(byTask.get(task) ?? []), entry]);
}

let done = 0;
for (const taskId of admitted) {
  if (only.length > 0 && !only.includes(taskId)) continue;
  if (results.units[taskId] !== undefined) continue;
  if (limit > 0 && done >= limit) break;

  const free = freeGb();
  if (free < DISK_FLOOR_GB) {
    console.log(`STOP: ${free.toFixed(1)} GiB free is below the ${DISK_FLOOR_GB} GiB floor`);
    break;
  }

  // Controls run WITH network, deliberately. Neither control involves an agent — the oracle and
  // the verifier are both scripts the benchmark ships — so there is nothing here to leak an answer
  // to. Several verifiers pip-install pytest at verify time, and denying them the package index
  // makes every test error and reports a false rejection. Egress restriction belongs on the arm
  // runs, where a real solver is present; applying it here measures the harness, not the task.
  const network = "bridge";
  const tag = `jinn-demo1/${taskId}:control`;
  let dir;
  process.stdout.write(`[${done + 1}] ${taskId} (${free.toFixed(1)} GiB free) `);
  try {
    dir = materialize(taskId, byTask.get(taskId) ?? []);
    const { pinned } = pinBase(dir);
    const dockerfile = existsSync(join(dir, "environment", "Dockerfile.pinned"))
      ? join(dir, "environment", "Dockerfile.pinned")
      : join(dir, "environment", "Dockerfile");
    sh(`docker build -q -f ${dockerfile} -t ${tag} ${join(dir, "environment")}`, { timeout: 1_800_000 });

    const oracleOut = sh(
      `docker run --rm --network ${network} -v "${join(dir, "oracle")}:/oracle:ro" -v "${join(dir, "verifier")}:/verifier:ro" ${tag} `
      + `bash -c 'cd /root; mkdir -p /logs/verifier; bash /oracle/solve.sh >/tmp/o.log 2>&1 || true; bash /verifier/test.sh >/tmp/v.log 2>&1 || true; echo REWARD=$(cat /logs/verifier/reward.txt 2>/dev/null || echo MISSING)'`,
      { timeout: 1_800_000 },
    );
    const noOpOut = sh(
      `docker run --rm --network ${network} -v "${join(dir, "verifier")}:/verifier:ro" ${tag} `
      + `bash -c 'cd /root; mkdir -p /logs/verifier; bash /verifier/test.sh >/tmp/v.log 2>&1 || true; echo REWARD=$(cat /logs/verifier/reward.txt 2>/dev/null || echo MISSING)'`,
      { timeout: 1_800_000 },
    );

    const oracle = readReward(oracleOut);
    const noOp = readReward(noOpOut);
    // Rewards are decimal, not string-equal: several tasks write "1.000000". Comparing strings
    // silently rejects a passing oracle, which is a wrong rejection no schema check would catch.
    const eligible = Number(oracle) === 1 && Number(noOp) === 0;
    results.units[taskId] = { baseImage: pinned, oracleReward: oracle, noOpReward: noOp, eligible };
    console.log(`oracle=${oracle} noop=${noOp} ${eligible ? "ELIGIBLE" : "rejected"}`);
  } catch (error) {
    results.units[taskId] = { error: String(error.message ?? error).slice(0, 300), eligible: false };
    console.log(`error: ${String(error.message ?? error).slice(0, 120)}`);
  } finally {
    try { sh(`docker rmi -f ${tag}`); } catch { /* image may not exist */ }
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
    writeFileSync(OUT, `${JSON.stringify(results, null, 2)}\n`);
  }
  done += 1;
}

const all = Object.entries(results.units);
const eligible = all.filter(([, r]) => r.eligible);
console.log(`\n${eligible.length} eligible / ${all.length} run / ${admitted.length} admitted`);
console.log(`evidence: ${OUT}`);
