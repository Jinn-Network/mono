#!/usr/bin/env node
/**
 * Mints the committed P5 micro-slate (`fixtures/p5-micro-slate/`).
 *
 *   node scripts/mint-micro-slate.mjs            # regenerate the fixture in place
 *   node scripts/mint-micro-slate.mjs --check    # fail if the committed fixture is stale
 *
 * The fixture is the post-P3b material-contract mint. Every row carries the canonical public
 * evaluation-row descriptor consumed by the product-owned OCI grader, a digest-addressed
 * `docker://` image URI, and the exact shipped parser/program/timeout identities.
 *
 * This script is deliberately the SEED of P0-interop's minting adaptation: `parseHfRow`,
 * `parseHfRow`, `fetchRows`, `resolveImage`, and `toSweRebenchRow` below mirror the proven path in
 * `packages/policy-optimization/src/host-local/swe-rebench-journey.ts` (`parseHfRow` :181-225,
 * `fetchRows` :276-294, `resolveImage` :295-311, the `SweRebenchRow` map :616-637) so the two
 * converge rather than diverge. In particular the gold solution is deliberately absent from
 * `parseHfRow` and the committed fixture. The separate green-baseline script fetches it only for
 * the grader control and never exposes it to a Task or solve workspace.
 *
 * Requires network access to datasets-server.huggingface.co. Image digests use the registry API
 * first and Docker only as a disk-gated fallback. Never run in CI.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { SWE_REBENCH_PARSER } from "@jinn-network/task-execution-evaluator-adapters";
import {
  canonicalJsonBytes,
  graderProgramDigest,
  sha256Hex,
} from "@jinn-network/task-execution-oci-grader";
import { assertP5DiskGate } from "./p5-disk-gate.mjs";

// ---------------------------------------------------------------------------
// Declared policy — every value here is fixed BEFORE any per-task result exists.
// ---------------------------------------------------------------------------

export const DATASET = "nebius/SWE-rebench-leaderboard";
export const CONFIG = "default";
export const SPLIT = "test";

/**
 * The R5-selected micro-slate: three tasks across three distinct source repos, chosen for the
 * smallest test surface available (all F2P = 1, P2P <= 6) so the grade legs are fast.
 *
 * Three distinct repos is a binding constraint, not a coincidence. The clustered bootstrap groups
 * by provenance source; a one-repo slate would pull one image instead of three and collapse
 * clusterCount to 1, silently skipping the clustering path the gate exists to exercise.
 */
export const INSTANCES = [
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
export const TIMEOUT_SECONDS = 1800;

/** R5 exclusion rules 3 and 4, declared numerically before selection. */
export const EXCLUSION_RULES = {
  maxFailToPass: 10,
  maxPassToPass: 100,
  minDistinctRepos: 3,
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

/** Mirrors the shipped SWE-rebench path: one shell command string is one exact command. */
function commandArray(value, key) {
  if (typeof value === "string") {
    if (value.trim() === "") fail(`row has an invalid ${key}`);
    return [value];
  }
  if (!Array.isArray(value) || value.length === 0
    || value.some((entry) => typeof entry !== "string" || entry.trim() === "")) {
    fail(`row has an invalid ${key}`);
  }
  return [...value];
}

/**
 * Narrows an untyped HF row to exactly the fields that may promote into sealed bytes.
 *
 * `patch` — the gold solution — is structurally absent from the returned shape, so it cannot leak
 * into a Task no matter what the upstream row carries. `test_patch` is public evaluation material
 * and is sealed through P3b's canonical descriptor contract.
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
  const installConfigValue = typeof row["install_config"] === "string"
    ? JSON.parse(row["install_config"])
    : row["install_config"];
  const installConfig = installConfigValue;
  if (typeof installConfig !== "object" || installConfig === null || Array.isArray(installConfig)) {
    fail(`row ${instanceId} has no install configuration`);
  }
  const install = commandArray(installConfig.install, "install_config.install");
  const testCmd = commandArray(installConfig.test_cmd, "install_config.test_cmd");
  const logParser = exactString(installConfig, "log_parser");
  return {
    instance_id: instanceId,
    repo,
    base_commit: baseCommit,
    problem_statement: exactString(row, "problem_statement"),
    created_at: exactString(row, "created_at"),
    image_name: exactString(row, "image_name"),
    test_patch: exactString(row, "test_patch"),
    FAIL_TO_PASS: failToPass,
    PASS_TO_PASS: stringArray(row["PASS_TO_PASS"], "PASS_TO_PASS"),
    install_config: { install, test_cmd: testCmd, log_parser: logParser },
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
 * P3b owns both boundaries used here: `pinnedSweRebenchImage` requires a `docker://` URI whose
 * embedded sha256 exactly equals the descriptor digest, and `rowMaterial` requires canonical
 * JSON bytes in the named `swe-rebench-evaluation-row` descriptor.
 */
export function toSweRebenchRow(row, imagePin) {
  if (!HEX_DIGEST.test(imagePin.digest)) fail(`${row.instance_id} has an unpinned image`);
  const hex = imagePin.digest.slice("sha256:".length);
  const material = canonicalJsonBytes({
    FAIL_TO_PASS: [...row.FAIL_TO_PASS],
    PASS_TO_PASS: [...row.PASS_TO_PASS],
    base_commit: row.base_commit,
    install_config: {
      install: [...row.install_config.install],
      log_parser: row.install_config.log_parser,
      test_cmd: [...row.install_config.test_cmd],
    },
    instance_id: row.instance_id,
    test_patch: row.test_patch,
  });
  return {
    instance_id: row.instance_id,
    repo: row.repo,
    base_commit: row.base_commit,
    problem_statement: row.problem_statement,
    language: row.language,
    image: {
      name: "swe-rebench-grader-image",
      uri: `docker://${imagePin.reference}`,
      digest: { sha256: hex },
    },
    testMaterial: [{
      name: "swe-rebench-evaluation-row",
      mediaType: "application/json",
      content: Buffer.from(material).toString("base64"),
      digest: { sha256: sha256Hex(material) },
    }],
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

export async function fetchRows() {
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

/**
 * Resolves a tag to its manifest digest via the public Docker Hub registry API, falling back to
 * the docker CLI.
 *
 * The registry API is primary so a re-mint needs no Docker daemon: this fixture is re-minted on a
 * schedule (once after the provenance cluster fix, again when the grading seam publishes its
 * material contract), and a mint that only works on a machine with Docker running is a mint that
 * silently stops being reproducible.
 *
 * The two sources were verified equivalent against this fixture's own docker-CLI-minted digests —
 * all three matched exactly — so this is a substitution, not a redefinition of what is pinned.
 */
export async function resolveImage(image) {
  const [repository] = image.split(":");
  const slash = repository.indexOf("/");
  const digest = slash === -1
    ? undefined
    : await hubDigest(repository.slice(0, slash), repository.slice(slash + 1), image.slice(repository.length + 1) || "latest");
  const resolved = digest ?? dockerDigest(image);
  if (typeof resolved !== "string" || !HEX_DIGEST.test(resolved)) {
    fail(`could not resolve a sha256 manifest digest for ${image}`);
  }
  return { source: image, reference: pinnedReference(image, resolved), digest: resolved };
}

async function hubDigest(namespace, repository, tag) {
  try {
    const url = `https://hub.docker.com/v2/repositories/${namespace}/${repository}/tags/${tag}`;
    const response = await fetch(url, { signal: AbortSignal.timeout(45_000) });
    if (!response.ok) return undefined;
    const digest = (await response.json()).digest;
    return typeof digest === "string" && HEX_DIGEST.test(digest) ? digest : undefined;
  } catch {
    return undefined; // Fall through to the docker CLI.
  }
}

function dockerDigest(image) {
  assertP5DiskGate(`Docker digest fallback for ${image}`);
  try {
    const output = execFileSync(
      "docker",
      ["buildx", "imagetools", "inspect", image, "--format", "{{json .Manifest}}"],
      { encoding: "utf8", timeout: 120_000, stdio: ["ignore", "pipe", "pipe"] },
    );
    return JSON.parse(output).digest;
  } catch (cause) {
    fail(
      `registry API did not resolve ${image} and the docker fallback failed `
      + `(is the daemon running?): ${cause instanceof Error ? cause.message : String(cause)}`,
    );
  }
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export async function mintMicroSlate({ checkOnly = false } = {}) {
  const diskAtStart = assertP5DiskGate(checkOnly ? "micro-slate check" : "micro-slate mint");
  const parsed = (await fetchRows()).map(parseHfRow);
  assertSlateAdmissible(parsed);

  const rows = [];
  const provenanceRows = [];
  for (const row of parsed) {
    const pin = await resolveImage(row.image_name);
    rows.push(toSweRebenchRow(row, pin));
    provenanceRows.push({
      instance_id: row.instance_id,
      repo: row.repo,
      base_commit: row.base_commit,
      createdAt: row.created_at,
      sourceUrl: `https://huggingface.co/datasets/${DATASET}`,
      imageName: pin.source,
      imageUri: `docker://${pin.reference}`,
      imageDigest: pin.digest,
    });
  }

  const provenance = {
    status: "FINAL P5 FIXTURE — minted after the P3b material contract",
    dataset: DATASET,
    config: CONFIG,
    split: SPLIT,
    mintedAt: new Date().toISOString(),
    parser: SWE_REBENCH_PARSER,
    graderProgramDigest: graderProgramDigest(),
    timeoutSeconds: TIMEOUT_SECONDS,
    exclusionRules: EXCLUSION_RULES,
    rows: provenanceRows,
  };

  const rowsText = `${JSON.stringify(rows, null, 2)}\n`;
  if (checkOnly) {
    const committed = readFileSync(`${FIXTURE_DIR}rows.json`, "utf8");
    if (committed !== rowsText) fail("micro-slate fixture is stale; run the mint command");
    // `mintedAt` legitimately moves on every run. Ignore only that instant; parser/program/
    // timeout/source provenance are part of the final fixture contract and must remain checked.
    const committedProvenance = JSON.parse(readFileSync(`${FIXTURE_DIR}provenance.json`, "utf8"));
    if (typeof committedProvenance?.mintedAt !== "string"
      || Number.isNaN(new Date(committedProvenance.mintedAt).valueOf())) {
      fail("micro-slate provenance has no valid mintedAt instant");
    }
    const expectedProvenance = { ...provenance, mintedAt: committedProvenance.mintedAt };
    if (JSON.stringify(committedProvenance) !== JSON.stringify(expectedProvenance)) {
      fail("micro-slate provenance is stale; run the mint command");
    }
    return { rows, provenance, changed: false, diskAtStart };
  }
  mkdirSync(FIXTURE_DIR, { recursive: true });
  writeFileSync(`${FIXTURE_DIR}rows.json`, rowsText);
  writeFileSync(`${FIXTURE_DIR}provenance.json`, `${JSON.stringify(provenance, null, 2)}\n`);
  return { rows, provenance, changed: true, diskAtStart };
}

if (process.argv[1] !== undefined
  && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const result = await mintMicroSlate({ checkOnly: process.argv.includes("--check") });
  console.log(
    `${result.changed ? "minted" : "verified"} ${result.rows.length} rows across `
      + `${new Set(result.rows.map((row) => row.repo)).size} distinct repos`,
  );
}
