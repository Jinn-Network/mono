#!/usr/bin/env node
/**
 * Mints the committed P5 micro-slate (`fixtures/p5-micro-slate/`).
 *
 *   node scripts/mint-micro-slate.mjs            # regenerate the fixture in place
 *   node scripts/mint-micro-slate.mjs --check    # fail if the committed fixture is stale
 *
 * The fixture is PROVISIONAL and regeneration is a one-command operation by design: the
 * P0-interop cluster-key fix changes the sealed provenance source and therefore every Task
 * digest, so this slate MUST be re-minted once that lands. Nothing outside the fixture files
 * records a digest.
 *
 * This script is deliberately the SEED of P0-interop's minting adaptation: `parseHfRow`,
 * `selectSlate` and `toSweRebenchRow` below mirror the proven path in
 * `packages/policy-optimization/src/host-local/swe-rebench-journey.ts` (`parseHfRow` :181-225,
 * `fetchRows` :276-294, `resolveImage` :295-311, the `SweRebenchRow` map :616-637) so the two
 * converge rather than diverge. In particular the gold-solution guard is carried over verbatim
 * in spirit: the parsed row shape has no `patch` field, so there is no code path that can leak
 * the gold solution into a sealed Task.
 *
 * Requires: network access to datasets-server.huggingface.co, and `docker` on PATH for image
 * digest resolution. Never run in CI.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { SWE_REBENCH_PARSER } from "@jinn-network/task-execution-evaluator-adapters";

// ---------------------------------------------------------------------------
// Declared policy — every value here is fixed BEFORE any per-task result exists.
// ---------------------------------------------------------------------------

const DATASET = "nebius/SWE-rebench-leaderboard";
const CONFIG = "default";
const SPLIT = "test";

/**
 * The R5-selected micro-slate: three tasks across three distinct source repos, chosen for the
 * smallest test surface available (all F2P = 1, P2P <= 6) so the grade legs are fast.
 *
 * Three distinct repos is a binding constraint, not a coincidence. The clustered bootstrap groups
 * by provenance source; a one-repo slate would pull one image instead of three and collapse
 * clusterCount to 1, silently skipping the clustering path the gate exists to exercise.
 */
const INSTANCES = [
  "gerlero__foamlib-329",
  "qBraid__pyqasm-120",
  "python-wheel-build__fromager-626",
];

/**
 * Upstream publishes no per-task timeout (the leaderboard's `harbor_verifier_timeout_sec` is null
 * on 856 of 860 rows), so it is a declared policy value. It is also the ONLY bound on the container
 * run (`container-grader-source.ts:385` wraps it in `AbortSignal.timeout`). 1800s matches the
 * upstream harness default and matches swe-rebench-journey.ts:635.
 */
const TIMEOUT_SECONDS = 1800;

/** R5 exclusion rules 3 and 4, declared numerically before selection. */
const EXCLUSION_RULES = {
  maxFailToPass: 10,
  maxPassToPass: 100,
  minDistinctRepos: 2,
};

const FIXTURE_DIR = fileURLToPath(new URL("../fixtures/p5-micro-slate/", import.meta.url));
const HEX_DIGEST = /^sha256:[a-f0-9]{64}$/u;

// ---------------------------------------------------------------------------
// Pure functions — the part P0-interop extends. No network, no filesystem.
// ---------------------------------------------------------------------------

function fail(message) {
  throw new Error(message);
}

function exactString(record, key) {
  const value = record[key];
  if (typeof value !== "string" || value.length === 0) fail(`row has no ${key}`);
  return value;
}

/** Upstream ships these as either a JSON array or a JSON-encoded string. Accept both. */
function stringArray(value, key) {
  const parsed = typeof value === "string" ? JSON.parse(value) : value;
  if (!Array.isArray(parsed) || parsed.some((entry) => typeof entry !== "string")) {
    fail(`row has an invalid ${key}`);
  }
  return [...parsed];
}

/**
 * Narrows an untyped HF row to exactly the fields that may promote into sealed bytes.
 *
 * `patch` — the gold solution — is structurally absent from the returned shape, so it cannot leak
 * into a Task no matter what the upstream row carries. `test_patch` is a different field (the
 * public test-only diff) and is deliberately NOT carried either: under the ruled pull-and-mount
 * grading design the test material reaches the grader through the P3 seam, not through the slate.
 */
export function parseHfRow(value) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) fail("row is not an object");
  const row = value;
  const instanceId = exactString(row, "instance_id");
  const repo = exactString(row, "repo");
  const baseCommit = exactString(row, "base_commit");
  if (!/^[^/\s]+\/[^/\s]+$/u.test(repo)) fail(`row ${instanceId} has an invalid repository`);
  if (!/^[a-f0-9]{40}$/u.test(baseCommit)) fail(`row ${instanceId} has an invalid base commit`);
  const failToPass = stringArray(row["FAIL_TO_PASS"], "FAIL_TO_PASS");
  if (failToPass.length === 0) fail(`row ${instanceId} is not scorable`);
  const installConfig = row["install_config"];
  if (typeof installConfig !== "object" || installConfig === null || Array.isArray(installConfig)) {
    fail(`row ${instanceId} has no install configuration`);
  }
  return {
    instance_id: instanceId,
    repo,
    base_commit: baseCommit,
    problem_statement: exactString(row, "problem_statement"),
    created_at: typeof row["created_at"] === "string" ? row["created_at"] : "",
    image_name: exactString(row, "image_name"),
    FAIL_TO_PASS: failToPass,
    PASS_TO_PASS: stringArray(row["PASS_TO_PASS"], "PASS_TO_PASS"),
    // The v1/leaderboard schema has no `language` column — that corpus is Python-only.
    language: typeof row["language"] === "string" && row["language"].length > 0 ? row["language"] : "python",
  };
}

/** Applies the declared exclusion rules. Throws rather than silently dropping a named instance. */
export function assertSlateAdmissible(parsedRows) {
  for (const row of parsedRows) {
    if (row.FAIL_TO_PASS.length > EXCLUSION_RULES.maxFailToPass) {
      fail(`${row.instance_id} exceeds the fail-to-pass cap (${row.FAIL_TO_PASS.length})`);
    }
    if (row.PASS_TO_PASS.length > EXCLUSION_RULES.maxPassToPass) {
      fail(`${row.instance_id} exceeds the pass-to-pass cap (${row.PASS_TO_PASS.length})`);
    }
  }
  const repos = new Set(parsedRows.map((row) => row.repo));
  if (repos.size < EXCLUSION_RULES.minDistinctRepos) {
    fail(`slate spans ${repos.size} distinct repos, below the declared minimum of ${EXCLUSION_RULES.minDistinctRepos}`);
  }
}

/**
 * Maps a parsed HF row plus its resolved image pin into a `SweRebenchRow`.
 *
 * The image reference is carried on `name` with NO `uri`. `pinnedImageReference`
 * (`container-grader-source.ts:180-200`) resolves `image.uri ?? image.name` and refuses anything
 * that is not a bare docker repository reference, so the `docker://` scheme that
 * swe-rebench-journey.ts:623 uses for its own grader would be refused there. Carrying it on `name`
 * satisfies both readings and keeps the fixture valid whichever grader P3 wires.
 *
 * `testMaterial` is left EMPTY on purpose. The schema permits it (`family-blocks.ts:82` has no
 * `.min(1)`), and under the ruled pull-and-mount design the evaluation material contract belongs
 * to the P3 grading seam — pinning it now to policy-optimization's current internal shape
 * (`swe-rebench-evaluation-row`, canonical-JSON base64) would be speculative. This slate is
 * re-minted when P3 publishes that contract.
 */
export function toSweRebenchRow(row, imagePin) {
  if (!HEX_DIGEST.test(imagePin.digest)) fail(`${row.instance_id} has an unpinned image`);
  const hex = imagePin.digest.slice("sha256:".length);
  return {
    instance_id: row.instance_id,
    repo: row.repo,
    base_commit: row.base_commit,
    problem_statement: row.problem_statement,
    language: row.language,
    image: { name: imagePin.reference, digest: { sha256: hex } },
    testMaterial: [],
    parser: SWE_REBENCH_PARSER,
    transitions: { failToPass: [...row.FAIL_TO_PASS], passToPass: [...row.PASS_TO_PASS] },
    timeout: TIMEOUT_SECONDS,
  };
}

/** `repo:tag` + digest -> `repo@sha256:...`. Mirrors swe-rebench-journey.ts:240-248. */
export function pinnedReference(image, digest) {
  if (!HEX_DIGEST.test(digest) || image.includes("@")) {
    fail(`resolved image ${image} is not a single sha256-pinned reference`);
  }
  const slash = image.lastIndexOf("/");
  const colon = image.lastIndexOf(":");
  const repository = colon > slash ? image.slice(0, colon) : image;
  return `${repository}@${digest}`;
}

// ---------------------------------------------------------------------------
// Effectful edges — network and docker. P0-interop replaces these with its own ports.
// ---------------------------------------------------------------------------

async function fetchRows() {
  const found = new Map();
  for (let offset = 0; offset < 900 && found.size < INSTANCES.length; offset += 100) {
    const url = new URL("https://datasets-server.huggingface.co/rows");
    url.searchParams.set("dataset", DATASET);
    url.searchParams.set("config", CONFIG);
    url.searchParams.set("split", SPLIT);
    url.searchParams.set("offset", String(offset));
    url.searchParams.set("length", "100");
    const response = await fetch(url, { signal: AbortSignal.timeout(30_000) });
    if (!response.ok) fail(`datasets-server returned HTTP ${response.status}`);
    const body = await response.json();
    if (!Array.isArray(body.rows) || body.rows.length === 0) break;
    for (const entry of body.rows) {
      if (INSTANCES.includes(entry.row?.instance_id)) found.set(entry.row.instance_id, entry.row);
    }
  }
  const missing = INSTANCES.filter((id) => !found.has(id));
  if (missing.length > 0) fail(`instances not found upstream: ${missing.join(", ")}`);
  // Preserve the declared order so the fixture is stable across runs.
  return INSTANCES.map((id) => found.get(id));
}

function resolveImage(image) {
  const output = execFileSync(
    "docker",
    ["buildx", "imagetools", "inspect", image, "--format", "{{json .Manifest}}"],
    { encoding: "utf8", timeout: 120_000 },
  );
  const digest = JSON.parse(output).digest;
  if (typeof digest !== "string" || !HEX_DIGEST.test(digest)) {
    fail(`docker returned no sha256 manifest digest for ${image}`);
  }
  return { source: image, reference: pinnedReference(image, digest), digest };
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

const checkOnly = process.argv.includes("--check");

const parsed = (await fetchRows()).map(parseHfRow);
assertSlateAdmissible(parsed);

const rows = [];
const provenanceRows = [];
for (const row of parsed) {
  const pin = resolveImage(row.image_name);
  rows.push(toSweRebenchRow(row, pin));
  provenanceRows.push({
    instance_id: row.instance_id,
    repo: row.repo,
    base_commit: row.base_commit,
    createdAt: row.created_at,
    sourceUrl: `https://huggingface.co/datasets/${DATASET}`,
    imageName: pin.source,
    imageDigest: pin.digest,
  });
}

const provenance = {
  status: "PROVISIONAL — re-mint required after the P0-interop cluster-key fix lands",
  dataset: DATASET,
  config: CONFIG,
  split: SPLIT,
  mintedAt: new Date().toISOString(),
  timeoutSeconds: TIMEOUT_SECONDS,
  exclusionRules: EXCLUSION_RULES,
  rows: provenanceRows,
};

const rowsText = `${JSON.stringify(rows, null, 2)}\n`;

if (checkOnly) {
  // `mintedAt` legitimately moves on every run, so --check compares the slate content only.
  const committed = readFileSync(`${FIXTURE_DIR}rows.json`, "utf8");
  if (committed !== rowsText) {
    console.error("micro-slate fixture is STALE — run `node scripts/mint-micro-slate.mjs`");
    process.exit(1);
  }
  console.log("micro-slate fixture is up to date");
} else {
  mkdirSync(FIXTURE_DIR, { recursive: true });
  writeFileSync(`${FIXTURE_DIR}rows.json`, rowsText);
  writeFileSync(`${FIXTURE_DIR}provenance.json`, `${JSON.stringify(provenance, null, 2)}\n`);
  console.log(
    `minted ${rows.length} rows across ${new Set(rows.map((row) => row.repo)).size} distinct repos`,
  );
}
