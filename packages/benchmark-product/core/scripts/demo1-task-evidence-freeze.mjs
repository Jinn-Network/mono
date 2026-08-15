#!/usr/bin/env node
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  DEMO1_PINNED_SKILLS_SOURCE,
  DEMO1_PERMISSIVE_TASK_LICENSES,
  buildDemo1PreRunFreezeV3,
  buildDemo1TaskEvidenceArtifact,
  canonicalDemo1PreRunFreezeV3Bytes,
  canonicalDemo1TaskEvidenceBytes,
  parseDemo1UpstreamSkill,
} from "../dist/index.js";

const PACKAGE_ROOT = fileURLToPath(new URL("../", import.meta.url));
const REPOSITORY_ROOT = resolve(PACKAGE_ROOT, "../../..");
const DEFAULT_OUTPUT = resolve(REPOSITORY_ROOT, "docs/superpowers/plans/demo-report-1");
const DEFAULT_POOL = resolve(homedir(), ".jinn-client/swe-rebench-v2/pool-cache.json");
const DEFAULT_VALIDATED = resolve(homedir(), ".jinn-client/swe-rebench-v2/validated-pool.json");
const OLD_FREEZE = resolve(DEFAULT_OUTPUT, "E1-pre-run-freeze.stop.v2.json");
const CANDIDATES = ["skills/brand-guidelines", "skills/frontend-design"];
const CONFLICT_PATHS = new Set(["CLAUDE.md", "AGENTS.md", "SKILL.md", ".cursorrules"]);

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function gitBlob(bytes) {
  return createHash("sha1").update(`blob ${bytes.length}\0`, "utf8").update(bytes).digest("hex");
}

function option(argv, name, fallback) {
  const index = argv.indexOf(name);
  if (index === -1) return fallback;
  const value = argv[index + 1];
  if (value === undefined || value.length === 0) throw new Error(`${name} requires a value`);
  return value;
}

async function pinnedCandidate(repositoryPath) {
  const identity = DEMO1_PINNED_SKILLS_SOURCE.candidates.find((candidate) => candidate.repositoryPath === repositoryPath);
  if (identity === undefined) throw new Error(`${repositoryPath} is absent from the pinned source inventory`);
  const url = `https://raw.githubusercontent.com/anthropics/skills/${DEMO1_PINNED_SKILLS_SOURCE.commit}/${identity.skill.path}`;
  const response = await fetch(url, { signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error(`pinned candidate fetch returned HTTP ${response.status}: ${repositoryPath}`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.length !== identity.skill.bytes || sha256(bytes) !== identity.skill.sha256 || gitBlob(bytes) !== identity.skill.gitBlob) {
    throw new Error(`${repositoryPath} bytes do not match the product-owned path/blob identity`);
  }
  const parsed = parseDemo1UpstreamSkill(bytes);
  return {
    repositoryPath,
    description: parsed.description,
    sourceMd: new TextDecoder("utf8", { fatal: true }).decode(parsed.sourceMd),
    skillMdBase64: Buffer.from(bytes).toString("base64"),
  };
}

function exactSnapshot(path, expected) {
  const bytes = readFileSync(path);
  const actual = sha256(bytes);
  if (actual !== expected.sha256 || bytes.length !== expected.bytes) {
    throw new Error(`${path} does not match the authorized recovery snapshot`);
  }
  return { bytes, value: JSON.parse(bytes.toString("utf8")) };
}

function validatedUniverse(pool, validated) {
  const tasks = [];
  for (const task of pool.tasks) {
    const result = validated.entries?.[task.instance_id];
    if (result?.scorable !== true) continue;
    if (typeof result.imageDigest !== "string" || typeof result.imageName !== "string" || typeof result.rowHash !== "string") {
      throw new Error(`${task.instance_id} has incomplete validated-pool identity`);
    }
    tasks.push({
      taskId: task.instance_id,
      repository: task.repo,
      dataset: task.hf_dataset,
      split: task.hf_split,
      baseCommit: task.base_commit,
      rowHash: result.rowHash,
      imageDigest: result.imageDigest,
      imageName: result.imageName,
      problemStatement: task.problem_statement,
      goldPatch: task.patch,
      testPatch: task.test_patch,
      // The local cache intentionally omits transition identities. They are fetched and sealed by
      // the dynamic OCI control only if static capacity makes such work legal.
      failToPass: [],
    });
  }
  const repositories = new Set(tasks.map((task) => task.repository));
  if (tasks.length !== 197 || repositories.size !== 123) {
    throw new Error(`authorized universe moved: ${tasks.length} tasks across ${repositories.size} repositories`);
  }
  return tasks;
}

async function githubResponse(url) {
  const response = await fetch(url, {
    headers: { Accept: "application/vnd.github+json", "User-Agent": "jinn-demo1-task-evidence" },
    signal: AbortSignal.timeout(30_000),
  });
  const text = await response.text();
  return { response, text, body: text.length === 0 ? null : JSON.parse(text) };
}

function evidenceRef(uri, bytes) {
  return { uri, sha256: sha256(bytes) };
}

async function repositoryStaticEvidence(entry) {
  const repository = entry.repository;
  const encodedRepository = repository.split("/").map(encodeURIComponent).join("/");
  const ref = encodeURIComponent(entry.baseCommit);
  const licenseUrl = `https://api.github.com/repos/${encodedRepository}/license?ref=${ref}`;
  const treeUrl = `https://api.github.com/repos/${encodedRepository}/git/trees/${ref}?recursive=1`;
  const [license, tree] = await Promise.all([githubResponse(licenseUrl), githubResponse(treeUrl)]);
  if (tree.response.status !== 200 || !Array.isArray(tree.body?.tree) || tree.body.truncated === true) {
    throw new Error(`${entry.taskId} exact-base recursive tree is unavailable or truncated (HTTP ${tree.response.status})`);
  }
  const paths = tree.body.tree.map((item) => item?.path).filter((path) => typeof path === "string").sort();
  const conflicts = paths.filter((path) => CONFLICT_PATHS.has(path.split("/").at(-1)));
  const conflictingInstructionFileAbsent = {
    status: conflicts.length === 0 ? "match" : "mismatch",
    detail: conflicts.length === 0
      ? "exact-base recursive repository tree contains no conflicting agent instruction file"
      : `exact-base recursive repository tree contains: ${conflicts.join(", ")}`,
    evidence: [evidenceRef(treeUrl, tree.text)],
  };

  const spdxId = license.response.status === 200 && typeof license.body?.license?.spdx_id === "string"
    ? license.body.license.spdx_id
    : null;
  if (![200, 404].includes(license.response.status)) {
    throw new Error(`${entry.taskId} exact-base license lookup returned HTTP ${license.response.status}`);
  }
  const compatible = spdxId !== null && DEMO1_PERMISSIVE_TASK_LICENSES.includes(spdxId);
  const compatibleTaskLicense = {
    status: compatible ? "match" : "mismatch",
    detail: compatible
      ? `exact-base repository license is permissive SPDX ${spdxId}`
      : `exact-base repository has no accepted permissive SPDX license (${spdxId ?? `HTTP ${license.response.status}`})`,
    evidence: [evidenceRef(licenseUrl, license.text)],
  };
  return { compatibleTaskLicense, conflictingInstructionFileAbsent };
}

function writeOrCheck(path, bytes, checkOnly) {
  if (checkOnly) {
    if (!existsSync(path) || !readFileSync(path).equals(Buffer.from(bytes))) {
      throw new Error(`${path} is stale; regenerate the task-evidence freeze`);
    }
  } else {
    writeFileSync(path, bytes, { flag: "w" });
  }
}

export async function freezeDemo1TaskEvidence({
  poolPath = DEFAULT_POOL,
  validatedPath = DEFAULT_VALIDATED,
  outputDirectory = DEFAULT_OUTPUT,
  checkOnly = false,
} = {}) {
  const pool = exactSnapshot(poolPath, {
    sha256: "3af257961dfc662a44227438f7ce211278a13a6d44a84a75c96870564779e64d",
    bytes: 7_751_413,
  });
  const validated = exactSnapshot(validatedPath, {
    sha256: "91af6499668c471820caeb06a6c1abcc4439983802e6fe86a34f5ead8a827032",
    bytes: 309_558,
  });
  if (validated.value.evalSemanticsVersion !== "4") {
    throw new Error("validated-pool evaluation semantics moved from version 4");
  }
  const candidates = await Promise.all(CANDIDATES.map(pinnedCandidate));
  const sourceSnapshots = {
    poolCacheSha256: sha256(pool.bytes),
    validatedPoolSha256: sha256(validated.bytes),
    validationSemanticsVersion: validated.value.evalSemanticsVersion,
  };
  const evidenceCandidates = candidates.map(({ skillMdBase64: _skill, ...candidate }) => candidate);
  const universe = validatedUniverse(pool.value, validated.value);
  const preliminary = buildDemo1TaskEvidenceArtifact({ sourceSnapshots, candidates: evidenceCandidates, tasks: universe });
  const externalEvidence = {};
  for (const entry of preliminary.entries.filter((item) => item.checks.domainCompatible.status === "match")) {
    externalEvidence[`${entry.candidate}\u0000${entry.taskId}`] = await repositoryStaticEvidence(entry);
  }
  const taskEvidence = buildDemo1TaskEvidenceArtifact({
    sourceSnapshots,
    candidates: evidenceCandidates,
    tasks: universe,
    externalEvidence,
  });
  const oldBytes = readFileSync(OLD_FREEZE);
  const old = JSON.parse(oldBytes.toString("utf8"));
  const { candidates: oldCandidates, ...method } = old.inputs;
  const skillBytesByPath = new Map(candidates.map((candidate) => [candidate.repositoryPath, candidate.skillMdBase64]));
  const freeze = buildDemo1PreRunFreezeV3({
    supersedes: { schema: old.schema, sha256: sha256(oldBytes) },
    method,
    candidates: oldCandidates.map(({ tasks: _tasks, ...candidate }) => ({
      ...candidate,
      ...(skillBytesByPath.has(candidate.repositoryPath)
        ? { skillMdBase64: skillBytesByPath.get(candidate.repositoryPath) }
        : {}),
    })),
    taskEvidence,
  });
  const taskEvidenceBytes = canonicalDemo1TaskEvidenceBytes(taskEvidence);
  const freezeBytes = canonicalDemo1PreRunFreezeV3Bytes(freeze);
  writeOrCheck(resolve(outputDirectory, "E1-task-evidence.v1.json"), taskEvidenceBytes, checkOnly);
  writeOrCheck(resolve(outputDirectory, "E1-pre-run-freeze.stop.v3.json"), freezeBytes, checkOnly);
  return {
    taskEvidence,
    freeze,
    taskEvidenceSha256: sha256(taskEvidenceBytes),
    freezeSha256: sha256(freezeBytes),
  };
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const argv = process.argv.slice(2);
  const result = await freezeDemo1TaskEvidence({
    poolPath: option(argv, "--pool", DEFAULT_POOL),
    validatedPath: option(argv, "--validated", DEFAULT_VALIDATED),
    outputDirectory: option(argv, "--output", DEFAULT_OUTPUT),
    checkOnly: argv.includes("--check"),
  });
  process.stdout.write(`${JSON.stringify({
    status: result.freeze.derived.status,
    stopReasons: result.freeze.derived.stopReasons,
    taskEvidenceSha256: result.taskEvidenceSha256,
    freezeSha256: result.freezeSha256,
    universe: result.taskEvidence.universe,
    candidates: result.taskEvidence.derived,
    execution: result.freeze.execution,
  }, null, 2)}\n`);
}
