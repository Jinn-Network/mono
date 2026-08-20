// SPDX-License-Identifier: MIT

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { join } from "node:path";
import {
  canonicalJsonBytes,
  prefixedDigest,
  tupleDigest,
  type JsonValue,
} from "@jinn-network/policy-identity";
import {
  BENCHMARKING_PROTOCOL,
  sealBenchmark,
} from "@jinn-network/benchmarking-records";
import { SWE_REBENCH_PARSER } from "@jinn-network/task-execution-evaluator-adapters";
import {
  REPOSITORY_WORK_PROFILE_URI,
  buildRepositoryWorkProfile,
  sealEvaluationSpec,
  sealTaskProfile,
  sweRebenchRowToTaskAndSpec,
  type DeterministicProcessBlock,
  type SweRebenchRow,
} from "@jinn-network/task-execution-profiles";
import {
  TASK_EXECUTION_PROTOCOL_URI,
  documentDigest,
  sealSubmission,
  sealTask,
} from "@jinn-network/task-execution-protocol";
import { compileLiveCampaignInputs, type SealedLiveCampaignInputs } from "../live-campaign-inputs.js";
import {
  captureNextRunPolicySnapshot,
  sealNextRunPolicySnapshot,
  type SealedNextRunPolicySnapshot,
} from "../next-run-policy-snapshot.js";
import {
  formPolicyOptimizationSplit,
  parseExactPolicyOptimizationSplitManifest,
  type SealedPolicyOptimizationSplitManifest,
  type SplitPoolCandidate,
} from "../split-manifest.js";
import { refuse } from "../errors.js";
import { classifyPayload, type PayloadClassification } from "../admission/payload-class.js";
import { localAdmissionAuthority } from "./local-admission.js";
import type { SealedLocalLoadoutArchive } from "./loadout-archive.js";
import { readVerifiedSupplyPool, type LiveSupplyPoolEntry } from "./supply-pool.js";
import { ensurePrivateDirectory, secureAtomicWrite, secureRead } from "./state.js";
import { liveSolverWrapperDigest } from "./solver-launcher.js";
import {
  declaredBaselineRevision,
  normalizeAffectedRoutes,
} from "./declared-baseline.js";
import {
  LOCAL_SWE_REBENCH_EVALUATION_METHOD,
  SWE_REBENCH_PUBLIC_NETWORK_EXTENSION,
} from "./swe-rebench-grader-source.js";

export const SWE_REBENCH_DATASET = "nebius/SWE-rebench-leaderboard" as const;
export const SWE_REBENCH_SOURCE_VERSION = "public-hf-swe-rebench/1.0" as const;
export const LOCAL_SWE_REBENCH_RUN_PLAN_FORMAT_TOKEN =
  "network.jinn.policy-optimization.local-swe-rebench-run-plan/1.0" as const;
const DEFAULT_CONFIG = "default";
const DEFAULT_SPLIT = "2026_02";
const DEFAULT_FETCH_LIMIT = 100;
const DEFAULT_CONFIRMATION_GROUPS = 6;
const HEX_DIGEST = /^sha256:[a-f0-9]{64}$/u;

interface HfRow {
  readonly instance_id: string;
  readonly repo: string;
  readonly base_commit: string;
  readonly problem_statement: string;
  readonly created_at: string;
  readonly image_name: string;
  readonly test_patch: string;
  readonly FAIL_TO_PASS: readonly string[];
  readonly PASS_TO_PASS: readonly string[];
  readonly install_config: {
    readonly install: readonly string[];
    readonly test_cmd: readonly string[];
    readonly log_parser: string;
  };
  readonly language?: string;
}

interface HfRowsResponse {
  readonly rows?: readonly { readonly row_idx?: number; readonly row?: unknown }[];
}

export interface PinnedImage {
  readonly source: string;
  readonly reference: string;
  readonly digest: string;
}

export interface PinnedHarness {
  readonly id: string;
  readonly executable: string;
  readonly digest: string;
  readonly version: string;
}

export interface SweRebenchJourneyPorts {
  readonly fetchRows: (input: {
    readonly dataset: string;
    readonly config: string;
    readonly split: string;
    readonly limit: number;
  }) => Promise<readonly unknown[]>;
  readonly resolveImage: (image: string) => Promise<PinnedImage>;
  readonly resolveHarness: (harness: string) => Promise<PinnedHarness>;
}

export interface PrepareSweRebenchJourneyInput {
  readonly stateRoot: string;
  readonly currentLoadout: SealedLocalLoadoutArchive;
  readonly candidateLoadout: SealedLocalLoadoutArchive;
  readonly routeName: string;
  /** Every named route the operator declares shares this baseline loadout. */
  readonly affectedRoutes: readonly string[];
  readonly harness: string;
  readonly model: string;
  readonly isolationPolicy: string;
  readonly now: () => Date;
  readonly source?: {
    readonly config?: string;
    readonly split?: string;
    readonly fetchLimit?: number;
    readonly confirmationGroups?: number;
  };
  readonly ports?: SweRebenchJourneyPorts;
}

export interface PreparedSweRebenchJourney {
  readonly campaign: SealedLiveCampaignInputs;
  readonly snapshot: SealedNextRunPolicySnapshot;
  readonly split: SealedPolicyOptimizationSplitManifest;
  readonly currentPayload: PayloadClassification;
  readonly candidatePayload: PayloadClassification;
  /** Host-private binding for the future run command; includes no task or secret bytes. */
  readonly runPlan: { readonly bytes: Uint8Array; readonly digest: string };
  readonly promotionBenchmark: { readonly bytes: Uint8Array; readonly digest: string };
  readonly source: {
    readonly dataset: typeof SWE_REBENCH_DATASET;
    readonly config: string;
    readonly split: string;
    readonly selectedInstances: readonly string[];
  };
  /** Writes the already-reviewed exact bytes. No network or image resolution happens here. */
  readonly persist: () => PersistedSweRebenchJourneyPaths;
}

export interface PersistedSweRebenchJourneyPaths {
  readonly root: string;
  readonly campaign: string;
  readonly snapshot: string;
  readonly split: string;
  readonly runPlan: string;
  readonly promotionBenchmark: string;
}

function exactString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== "string" || value.length === 0) {
    refuse("invalid-document", `sweRebench.${key}`, `public SWE-rebench row has no ${key}`);
  }
  return value;
}

function stringArray(record: Record<string, unknown>, key: string): string[] {
  const value = record[key];
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    refuse("invalid-document", `sweRebench.${key}`, `public SWE-rebench row has invalid ${key}`);
  }
  return [...value] as string[];
}

function commandArray(value: unknown): string[] {
  if (typeof value === "string") return value.trim() === "" ? [] : [value];
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) return [];
  return value.filter((entry): entry is string => typeof entry === "string" && entry.trim() !== "");
}

function parseHfRow(value: unknown): HfRow {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    refuse("invalid-document", "sweRebench.row", "public SWE-rebench row is not an object");
  }
  const row = value as Record<string, unknown>;
  const instanceId = exactString(row, "instance_id");
  const repo = exactString(row, "repo");
  const baseCommit = exactString(row, "base_commit");
  if (!/^[^/\s]+\/[^/\s]+$/u.test(repo) || !/^[a-f0-9]{40}$/u.test(baseCommit)) {
    refuse("invalid-document", "sweRebench.row", `row ${instanceId} has an invalid repository or base commit`);
  }
  const failToPass = stringArray(row, "FAIL_TO_PASS");
  if (failToPass.length === 0) {
    refuse("invalid-document", "sweRebench.FAIL_TO_PASS", `row ${instanceId} is not scorable`);
  }
  const installConfig = row["install_config"];
  if (typeof installConfig !== "object" || installConfig === null || Array.isArray(installConfig)) {
    refuse("invalid-document", "sweRebench.install_config", `row ${instanceId} has no install configuration`);
  }
  const installRecord = installConfig as Record<string, unknown>;
  const testCommands = commandArray(installRecord["test_cmd"]);
  const logParser = installRecord["log_parser"];
  if (testCommands.length === 0 || typeof logParser !== "string" || logParser.length === 0) {
    refuse("invalid-document", "sweRebench.install_config", `row ${instanceId} has no scorable test command or parser`);
  }
  return {
    instance_id: instanceId,
    repo,
    base_commit: baseCommit,
    problem_statement: exactString(row, "problem_statement"),
    created_at: exactString(row, "created_at"),
    image_name: exactString(row, "image_name"),
    test_patch: typeof row["test_patch"] === "string" ? row["test_patch"] : "",
    FAIL_TO_PASS: failToPass,
    PASS_TO_PASS: stringArray(row, "PASS_TO_PASS"),
    install_config: {
      install: commandArray(installRecord["install"]),
      test_cmd: testCommands,
      log_parser: logParser,
    },
    ...(typeof row["language"] === "string" && row["language"].length > 0
      ? { language: row["language"] }
      : {}),
  };
}

function upstreamTimestamp(value: string): string {
  const match = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})(?:\.\d+)?(?:Z)?$/u.exec(value);
  if (match === null) {
    refuse("invalid-document", "sweRebench.created_at", "upstream row timestamp is not a supported UTC instant");
  }
  const normalized = `${match[1]}T${match[2]}Z`;
  const parsed = new Date(normalized);
  if (Number.isNaN(parsed.valueOf()) || parsed.toISOString().replace(".000Z", "Z") !== normalized) {
    refuse("invalid-document", "sweRebench.created_at", "upstream row timestamp is not calendar-valid");
  }
  return normalized;
}

function pinnedReference(image: string, digest: string): string {
  if (!HEX_DIGEST.test(digest) || image.includes("@")) {
    refuse("invalid-document", "sweRebench.image", "resolved grader image is not a single sha256-pinned reference");
  }
  const slash = image.lastIndexOf("/");
  const colon = image.lastIndexOf(":");
  const repository = colon > slash ? image.slice(0, colon) : image;
  return `${repository}@${digest}`;
}

async function collectProcess(command: string, args: readonly string[], timeoutMs: number): Promise<string> {
  const child = spawn(command, [...args], {
    stdio: ["ignore", "pipe", "pipe"],
    env: { PATH: process.env["PATH"] ?? "/usr/bin:/bin" },
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => { stdout += chunk; });
  child.stderr.on("data", (chunk: string) => { if (stderr.length < 4096) stderr += chunk; });
  const result = await new Promise<{ code: number | null; timedOut: boolean }>((resolveResult, reject) => {
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, timeoutMs);
    child.once("error", reject);
    child.once("exit", (code) => { clearTimeout(timer); resolveResult({ code, timedOut }); });
  }).catch(() => refuse("invalid-document", "sweRebench.image", "Docker image resolver is unavailable"));
  if (result.timedOut || result.code !== 0) {
    const safe = stderr.replaceAll(/[\r\n\t]+/gu, " ").slice(0, 240);
    refuse("invalid-document", "sweRebench.image", result.timedOut
      ? "Docker image resolution exceeded 60 seconds"
      : `Docker could not resolve the public grader image${safe === "" ? "" : ` (${safe})`}`);
  }
  return stdout;
}

export const defaultSweRebenchJourneyPorts: SweRebenchJourneyPorts = {
  async fetchRows(input) {
    const url = new URL("https://datasets-server.huggingface.co/rows");
    url.searchParams.set("dataset", input.dataset);
    url.searchParams.set("config", input.config);
    url.searchParams.set("split", input.split);
    url.searchParams.set("offset", "0");
    url.searchParams.set("length", String(input.limit));
    const signal = AbortSignal.timeout(30_000);
    let response: Response;
    try { response = await fetch(url, { signal }); }
    catch { refuse("invalid-document", "sweRebench.source", "public SWE-rebench source is unavailable"); }
    if (!response.ok) refuse("invalid-document", "sweRebench.source", `public SWE-rebench source returned HTTP ${response.status}`);
    let body: HfRowsResponse;
    try { body = await response.json() as HfRowsResponse; }
    catch { refuse("invalid-document", "sweRebench.source", "public SWE-rebench source returned invalid JSON"); }
    if (!Array.isArray(body.rows)) refuse("invalid-document", "sweRebench.source", "public SWE-rebench source returned no rows");
    return body.rows.map((entry) => entry.row);
  },
  async resolveImage(image) {
    const output = await collectProcess(
      "docker",
      ["buildx", "imagetools", "inspect", image, "--format", "{{json .Manifest}}"],
      60_000,
    );
    let manifest: unknown;
    try { manifest = JSON.parse(output); }
    catch { refuse("invalid-document", "sweRebench.image", "Docker returned an invalid image manifest"); }
    const digest = typeof manifest === "object" && manifest !== null && !Array.isArray(manifest)
      ? (manifest as Record<string, unknown>)["digest"]
      : undefined;
    if (typeof digest !== "string" || !HEX_DIGEST.test(digest)) {
      refuse("invalid-document", "sweRebench.image", "Docker returned no sha256 manifest digest");
    }
    return { source: image, reference: pinnedReference(image, digest), digest };
  },
  async resolveHarness(harness) {
    if (!/^[a-z0-9][a-z0-9._-]*$/u.test(harness)) {
      refuse("invalid-document", "route.harness", "solver harness name is not portable");
    }
    const executable = (await collectProcess("which", [harness], 10_000)).trim();
    if (executable === "" || executable.includes("\n")) {
      refuse("invalid-document", "route.harness", "solver harness executable is unavailable or ambiguous");
    }
    let exactPath: string;
    let bytes: Uint8Array;
    try {
      exactPath = realpathSync(executable);
      bytes = new Uint8Array(readFileSync(exactPath));
    } catch {
      refuse("invalid-document", "route.harness", "solver harness executable cannot be read exactly");
    }
    const rawVersion = (await collectProcess(exactPath, ["--version"], 20_000)).trim();
    const version = rawVersion.split(/\r?\n/u, 1)[0]?.trim() ?? "";
    if (version === "" || /[\u0000-\u001f\u007f]/u.test(version)) {
      refuse("invalid-document", "route.harness", "solver harness returned no stable version identity");
    }
    return {
      id: harness,
      executable: exactPath,
      digest: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
      version,
    };
  },
};

interface SelectedHfRow {
  readonly row: HfRow;
  readonly previouslyAttempted: boolean;
}

interface AttemptedGroupHistory {
  readonly members: ReadonlySet<string>;
  readonly repositories: ReadonlySet<string>;
  readonly sourceLineage: ReadonlySet<string>;
}

function consumedGroupHistory(stateRoot: string): AttemptedGroupHistory {
  const members = new Set<string>();
  const repositories = new Set<string>();
  const sourceLineage = new Set<string>();
  const consumeRoot = join(stateRoot, "consumed-confirmation");
  if (existsSync(consumeRoot)) {
    if (lstatSync(consumeRoot).isSymbolicLink() || !lstatSync(consumeRoot).isDirectory()) {
      refuse("invalid-document", "sweRebench.history", "consumed confirmation history is not a safe directory");
    }
    for (const name of readdirSync(consumeRoot).sort()) {
      const markerRoot = join(consumeRoot, name);
      if (lstatSync(markerRoot).isSymbolicLink() || !lstatSync(markerRoot).isDirectory()) {
        refuse("invalid-document", "sweRebench.history", "consumed confirmation history contains an unsafe entry");
      }
      const markerPath = join(markerRoot, "consumption.json");
      if (!existsSync(markerPath)) continue;
      let value: unknown;
      try { value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(secureRead(markerPath))); }
      catch { refuse("invalid-document", "sweRebench.history", "consumption marker is not UTF-8 JSON"); }
      if (typeof value !== "object" || value === null || Array.isArray(value)) {
        refuse("invalid-document", "sweRebench.history", "consumption marker is not an object");
      }
      const marker = value as Record<string, unknown>;
      const arrays = [marker["members"], marker["repositories"], marker["sourceLineage"]];
      if (arrays.every((entry) => entry === undefined)) continue; // Compatibility with v0 markers.
      if (arrays.some((entry) => !Array.isArray(entry)
        || entry.some((item) => typeof item !== "string" || item.length === 0))) {
        refuse("invalid-document", "sweRebench.history", "consumption marker lineage is malformed");
      }
      (marker["members"] as string[]).forEach((item) => members.add(item));
      (marker["repositories"] as string[]).forEach((item) => repositories.add(item));
      (marker["sourceLineage"] as string[]).forEach((item) => sourceLineage.add(item));
    }
  }
  const preparedRoot = join(stateRoot, "prepared");
  if (!existsSync(preparedRoot)) return { members, repositories, sourceLineage };
  if (lstatSync(preparedRoot).isSymbolicLink() || !lstatSync(preparedRoot).isDirectory()) {
    refuse("invalid-document", "sweRebench.history", "prepared campaign history is not a safe directory");
  }
  for (const name of readdirSync(preparedRoot).sort()) {
    const campaignRoot = join(preparedRoot, name);
    if (lstatSync(campaignRoot).isSymbolicLink() || !lstatSync(campaignRoot).isDirectory()) {
      refuse("invalid-document", "sweRebench.history", "prepared campaign history contains an unsafe entry");
    }
    const splitPath = join(campaignRoot, "split-manifest.json");
    if (!existsSync(splitPath)) continue;
    const split = parseExactPolicyOptimizationSplitManifest(secureRead(splitPath));
    const consumed = new Set(split.assignments.promotion);
    for (const group of split.groups) {
      if (!consumed.has(group.groupId)) continue;
      group.members.forEach((value) => members.add(value));
      group.repositories.forEach((value) => repositories.add(value));
      group.sourceLineage.forEach((value) => sourceLineage.add(value));
    }
  }
  return { members, repositories, sourceLineage };
}

function selectIndependentRows(
  values: readonly unknown[],
  groups: number,
  history: AttemptedGroupHistory,
): SelectedHfRow[] {
  const selected: SelectedHfRow[] = [];
  const repositories = new Set<string>();
  const problemLineages = new Set<string>();
  let eligibleGroups = 0;
  for (const value of values) {
    let row: HfRow;
    try { row = parseHfRow(value); }
    catch { continue; }
    const problemLineage = prefixedDigest(new TextEncoder().encode(row.problem_statement));
    const repository = `https://github.com/${row.repo}`;
    const previouslyAttempted = history.members.has(row.instance_id)
      || history.repositories.has(repository)
      || history.sourceLineage.has(`problem:${problemLineage}`);
    if (previouslyAttempted) {
      selected.push({ row, previouslyAttempted: true });
      continue;
    }
    if (repositories.has(row.repo) || problemLineages.has(problemLineage)) continue;
    repositories.add(row.repo);
    problemLineages.add(problemLineage);
    selected.push({ row, previouslyAttempted: false });
    eligibleGroups += 1;
    if (eligibleGroups === groups) break;
  }
  if (eligibleGroups < groups) {
    refuse("invalid-document", "sweRebench.groups", `${eligibleGroups} fresh independent public task groups cannot satisfy the requested ${groups}`);
  }
  return selected;
}

function uuidFromDigest(digest: string): string {
  const hex = digest.slice("sha256:".length, "sha256:".length + 32).split("");
  hex[12] = "5";
  hex[16] = ["8", "9", "a", "b"][Number.parseInt(hex[16]!, 16) % 4]!;
  const value = hex.join("");
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20)}`;
}

function routeRequirements(
  input: PrepareSweRebenchJourneyInput,
  harness: PinnedHarness,
  loadoutTreeDigest: string,
): JsonValue {
  return {
    harness: { id: harness.id, version: harness.version, digest: harness.digest },
    isolationPolicy: input.isolationPolicy,
    loadout: { kind: "jinn.harness-state.v1", name: "learner-public", digest: loadoutTreeDigest },
    model: { id: input.model },
  };
}

function deadline(now: Date): string {
  const value = now.valueOf();
  if (Number.isNaN(value)) refuse("invalid-document", "clock", "host supplied an invalid preparation clock");
  return new Date(value + 24 * 60 * 60 * 1000).toISOString();
}

function persistPrepared(input: {
  readonly stateRoot: string;
  readonly campaign: SealedLiveCampaignInputs;
  readonly snapshot: SealedNextRunPolicySnapshot;
  readonly split: SealedPolicyOptimizationSplitManifest;
  readonly pool: readonly LiveSupplyPoolEntry[];
  readonly receipts: ReadonlyMap<string, Uint8Array>;
  readonly currentLoadout: SealedLocalLoadoutArchive;
  readonly candidateLoadout: SealedLocalLoadoutArchive;
  readonly runPlan: { readonly bytes: Uint8Array; readonly digest: string };
  readonly promotionBenchmark: { readonly bytes: Uint8Array; readonly digest: string };
  readonly promotionGroupIds: readonly string[];
}): PersistedSweRebenchJourneyPaths {
  // Persist every consumption marker before revealing any confirmation Task or Benchmark bytes.
  // An interrupted write can only consume too much; it can never make a revealed group reusable.
  for (const groupId of input.promotionGroupIds) {
    const group = input.split.manifest.groups.find((candidate) => candidate.groupId === groupId);
    if (group === undefined) {
      refuse("invalid-document", "sweRebench.groups", "promotion assignment names no sealed group");
    }
    secureAtomicWrite(
      join(input.stateRoot, "consumed-confirmation", groupId.slice("sha256:".length), "consumption.json"),
      canonicalJsonBytes({
        campaignDigest: input.campaign.digest,
        cause: "revealed",
        groupId,
        members: group.members,
        repositories: group.repositories,
        sourceLineage: group.sourceLineage,
        splitManifestDigest: input.split.digest,
      }),
      true,
    );
  }
  const root = ensurePrivateDirectory(join(
    input.stateRoot,
    "prepared",
    input.campaign.digest.slice("sha256:".length),
  ));
  const write = (name: string, bytes: Uint8Array) => {
    const path = join(root, name);
    secureAtomicWrite(path, bytes, true);
    return path;
  };
  const campaign = write("campaign-inputs.json", input.campaign.bytes);
  const snapshot = write("next-run-policy-snapshot.json", input.snapshot.bytes);
  const split = write("split-manifest.json", input.split.bytes);
  const runPlan = write("run-plan.json", input.runPlan.bytes);
  const promotionBenchmark = write("promotion-benchmark.json", input.promotionBenchmark.bytes);
  write("loadout-current.json", input.currentLoadout.bytes);
  write("loadout-candidate.json", input.candidateLoadout.bytes);
  const poolRoot = ensurePrivateDirectory(join(root, "pool"));
  for (const entry of input.pool) {
    const taskRoot = ensurePrivateDirectory(join(poolRoot, entry.taskDigest.slice("sha256:".length)));
    secureAtomicWrite(join(taskRoot, "task.json"), entry.taskBytes, true);
    secureAtomicWrite(join(taskRoot, "evaluation-spec.json"), entry.evaluationSpecBytes, true);
    const receipt = input.receipts.get(entry.receiptDigest);
    if (receipt === undefined) refuse("invalid-document", "sweRebench.receipt", "prepared pool receipt disappeared before persistence");
    secureAtomicWrite(join(taskRoot, "admission.dsse.json"), receipt, true);
  }
  return { root, campaign, snapshot, split, runPlan, promotionBenchmark };
}

/**
 * Builds the first real journey input set: one current loadout, one operator-chosen challenger,
 * and the configured number of fresh public SWE-rebench provenance groups. This prepares exact
 * bytes only; dispatch is a later explicit action.
 */
export async function prepareSweRebenchJourney(
  input: PrepareSweRebenchJourneyInput,
): Promise<PreparedSweRebenchJourney> {
  if (input.routeName.length === 0 || input.harness.length === 0 || input.model.length === 0
    || input.isolationPolicy.length === 0) {
    refuse("invalid-document", "route", "route, harness, model, and isolation policy are required");
  }
  if (input.harness !== "codex" || input.isolationPolicy !== "unrestricted") {
    refuse("invalid-document", "route", "the first live journey supports the codex harness with unrestricted local execution only");
  }
  if (input.currentLoadout.treeDigest === input.candidateLoadout.treeDigest) {
    refuse("invalid-document", "candidateLoadout", "candidate loadout is byte-identical to the current loadout");
  }
  const config = input.source?.config ?? DEFAULT_CONFIG;
  const splitName = input.source?.split ?? DEFAULT_SPLIT;
  const fetchLimit = input.source?.fetchLimit ?? DEFAULT_FETCH_LIMIT;
  const confirmationGroups = input.source?.confirmationGroups ?? DEFAULT_CONFIRMATION_GROUPS;
  if (!Number.isSafeInteger(fetchLimit) || fetchLimit < confirmationGroups || fetchLimit > 100
    || !Number.isSafeInteger(confirmationGroups) || confirmationGroups < 1) {
    refuse("invalid-document", "source", "fetch limit and confirmation group count are invalid");
  }
  const ports = input.ports ?? defaultSweRebenchJourneyPorts;
  const rawRows = await ports.fetchRows({
    dataset: SWE_REBENCH_DATASET,
    config,
    split: splitName,
    limit: fetchLimit,
  });
  const selected = selectIndependentRows(
    rawRows,
    confirmationGroups,
    consumedGroupHistory(input.stateRoot),
  );
  const [harness, images] = await Promise.all([
    ports.resolveHarness(input.harness),
    Promise.all(selected.map(({ row }) => ports.resolveImage(row.image_name))),
  ]);
  if (harness.id !== input.harness || !HEX_DIGEST.test(harness.digest)
    || harness.version.length === 0 || harness.executable.length === 0) {
    refuse("invalid-document", "route.harness", "resolved harness identity contradicts the selected route");
  }
  const profile = buildRepositoryWorkProfile();
  const sealedProfile = sealTaskProfile(profile);
  const route = { taskProfile: REPOSITORY_WORK_PROFILE_URI, route: input.routeName };
  const affectedRoutes = normalizeAffectedRoutes(
    route,
    input.affectedRoutes.map((name) => ({ taskProfile: REPOSITORY_WORK_PROFILE_URI, route: name })),
  );
  const authority = localAdmissionAuthority(input.stateRoot);
  const entries: LiveSupplyPoolEntry[] = [];
  const receipts = new Map<string, Uint8Array>();
  const assessment = new Map<string, {
    readonly id: string;
    readonly repository: string;
    readonly sourceLineage: readonly string[];
    readonly workIdentity: string;
    readonly sourceCommitment: string;
    readonly previouslyAttempted: boolean;
  }>();

  selected.forEach(({ row, previouslyAttempted }, index) => {
    const image = images[index]!;
    const timestamp = upstreamTimestamp(row.created_at);
    const evaluationMaterial = canonicalJsonBytes({
      FAIL_TO_PASS: row.FAIL_TO_PASS,
      PASS_TO_PASS: row.PASS_TO_PASS,
      base_commit: row.base_commit,
      image_name: image.reference,
      install_config: row.install_config,
      instance_id: row.instance_id,
      repo: row.repo,
      test_patch: row.test_patch,
    } as unknown as JsonValue);
    const sourceCommitment = prefixedDigest(canonicalJsonBytes({
      createdAt: timestamp,
      dataset: SWE_REBENCH_DATASET,
      evaluationMaterialDigest: prefixedDigest(evaluationMaterial),
      instanceId: row.instance_id,
      split: splitName,
    }));
    const mappedRow: SweRebenchRow = {
      instance_id: row.instance_id,
      repo: row.repo,
      base_commit: row.base_commit,
      problem_statement: row.problem_statement,
      language: row.language ?? "python",
      image: {
        name: "swe-rebench-grader-image",
        uri: `docker://${image.reference}`,
        digest: { sha256: image.digest.slice("sha256:".length) },
      },
      testMaterial: [{
        name: "swe-rebench-evaluation-row",
        content: Buffer.from(evaluationMaterial).toString("base64"),
        digest: { sha256: prefixedDigest(evaluationMaterial).slice("sha256:".length) },
        mediaType: "application/json",
      }],
      parser: SWE_REBENCH_PARSER,
      transitions: { failToPass: [...row.FAIL_TO_PASS], passToPass: [...row.PASS_TO_PASS] },
      timeout: 1_800,
    };
    const mapped = sweRebenchRowToTaskAndSpec(mappedRow);
    const sealedEvaluation = sealEvaluationSpec({
      ...mapped.evaluationSpec,
      familyBlock: {
        ...(mapped.evaluationSpec.familyBlock as DeterministicProcessBlock),
        [SWE_REBENCH_PUBLIC_NETWORK_EXTENSION]: true,
      },
    });
    const taskBytes = sealTask({
      protocol: TASK_EXECUTION_PROTOCOL_URI,
      profile: {
        uri: REPOSITORY_WORK_PROFILE_URI,
        digest: { sha256: sealedProfile.digest.slice("sha256:".length) },
      },
      instructions: row.problem_statement,
      payload: {
        ...(mapped.taskPayload as Record<string, unknown>),
        provenance: { kind: "mined", sourceCommitment, timestamp },
      },
      inputs: mapped.taskInputs,
      outputs: profile.outputConventions.slots.map((slot) => ({
        name: slot.name,
        mediaType: slot.mediaType,
        required: slot.required,
      })),
      evaluation: { digest: { sha256: sealedEvaluation.digest.slice("sha256:".length) } },
    });
    const taskDigest = documentDigest(taskBytes);
    const receiptBytes = authority.seal({
      taskDigest,
      evaluationSpecDigest: sealedEvaluation.digest,
      strategyId: SWE_REBENCH_SOURCE_VERSION,
      sourceCommitment,
    });
    const receiptDigest = prefixedDigest(receiptBytes);
    receipts.set(receiptDigest, receiptBytes);
    const problemLineage = prefixedDigest(new TextEncoder().encode(row.problem_statement));
    const entry: LiveSupplyPoolEntry = {
      taskDigest,
      taskBytes,
      evaluationSpecDigest: sealedEvaluation.digest,
      evaluationSpecBytes: sealedEvaluation.bytes,
      receiptDigest,
      environmentRecordDigest: prefixedDigest(canonicalJsonBytes({
        image: image.reference,
        platform: "linux/amd64",
      })),
      strategyId: SWE_REBENCH_SOURCE_VERSION,
      provenance: {
        config,
        dataset: SWE_REBENCH_DATASET,
        instanceId: row.instance_id,
        sourceCommitment,
        split: splitName,
        timestamp,
      },
      rights: { access: "public", source: "Hugging Face datasets-server" },
    };
    entries.push(entry);
    assessment.set(taskDigest, {
      id: row.instance_id,
      repository: `https://github.com/${row.repo}`,
      sourceLineage: [
        `hf://${SWE_REBENCH_DATASET}/${config}/${splitName}/${row.instance_id}`,
        `problem:${problemLineage}`,
      ],
      workIdentity: `${SWE_REBENCH_DATASET}/${splitName}/${row.instance_id}`,
      sourceCommitment,
      previouslyAttempted,
    });
  });

  const candidates = await readVerifiedSupplyPool({
    pool: {
      list: async () => entries,
      get: async (taskDigest) => entries.find((entry) => entry.taskDigest === taskDigest),
    },
    receipts: { get: async (receiptDigest) => receipts.get(receiptDigest) },
    receiptVerifier: {
      verify: (request) => authority.verify({
        issuer: request.issuer,
        keyId: request.keyId,
        preAuthEncoding: request.preAuthEncoding,
        signature: request.signature,
      }),
    },
    assessment: {
      assess: ({ entry }) => {
        const source = assessment.get(entry.taskDigest);
        if (source === undefined) refuse("invalid-document", "sweRebench.pool", "verified pool entry has no source assessment");
        return {
          id: source.id,
          repository: source.repository,
          sourceLineage: source.sourceLineage,
          workIdentity: source.workIdentity,
          tupleClass: "repository-work/1.0",
          compatible: true,
          previouslyAttempted: source.previouslyAttempted,
          contaminated: false,
          scorable: true,
        };
      },
    },
  });
  if (candidates.length !== selected.length || candidates.some((candidate) => !candidate.admission.verified)) {
    refuse("invalid-document", "sweRebench.pool", "not every selected public task passed exact local admission");
  }

  const representativeCandidate = candidates.find((candidate) => !candidate.previouslyAttempted);
  const representative = representativeCandidate === undefined
    ? undefined
    : entries.find((entry) => entry.taskDigest === representativeCandidate.task.digest);
  if (representative === undefined) {
    refuse("invalid-document", "sweRebench.groups", "no fresh representative task remains after exclusions");
  }
  const requirements = routeRequirements(input, harness, input.currentLoadout.treeDigest);
  const configRevision = declaredBaselineRevision({
    route,
    affectedRoutes,
    profileDigest: sealedProfile.digest,
    harness: {
      id: harness.id,
      executable: harness.executable,
      digest: harness.digest,
      version: harness.version,
    },
    model: input.model,
    isolationPolicy: input.isolationPolicy,
    loadout: {
      archiveDigest: input.currentLoadout.archiveDigest,
      treeDigest: input.currentLoadout.treeDigest,
    },
    requirements,
  });
  const submissionIdentity = prefixedDigest(canonicalJsonBytes({
    configRevision,
    taskDigest: representative.taskDigest,
  }));
  const submissionBytes = sealSubmission({
    protocol: TASK_EXECUTION_PROTOCOL_URI,
    submission: `urn:uuid:${uuidFromDigest(submissionIdentity)}`,
    task: { digest: { sha256: representative.taskDigest.slice("sha256:".length) } },
    requester: "urn:jinn:policy-optimization:local-operator",
    idempotencyKey: `snapshot/${submissionIdentity}`,
    nonce: `snapshot/${submissionIdentity}`,
    deadline: deadline(input.now()),
    requirements,
  });
  const snapshot = sealNextRunPolicySnapshot(captureNextRunPolicySnapshot({
    configRevisionBefore: configRevision,
    configRevisionAfter: configRevision,
    resolutions: [{
      route,
      task: { bytes: representative.taskBytes, digest: representative.taskDigest },
      submission: { bytes: submissionBytes, digest: documentDigest(submissionBytes) },
      profile: {
        bytes: sealedProfile.bytes,
        digest: sealedProfile.digest,
        profile: profile.profile,
        requirementKeys: profile.requirementKeys,
      },
      loadout: { bytes: input.currentLoadout.bytes, digest: input.currentLoadout.archiveDigest },
    }],
  }));
  const split = formPolicyOptimizationSplit({
    candidates: candidates as readonly SplitPoolCandidate[],
    tupleClass: "repository-work/1.0",
    seed: { tupleDigest: snapshot.snapshot.seed.digest, snapshotDigest: snapshot.digest },
    allocation: {
      preset: "custom@1",
      journey: "confirm-only",
      proposalGroups: 0,
      selectionGroups: 0,
      confirmationGroups,
    },
  });
  const currentPayload = classifyPayload(input.currentLoadout.entries, "jinn.harness-state.v1");
  const candidatePayload = classifyPayload(input.candidateLoadout.entries, "jinn.harness-state.v1");
  const campaign = compileLiveCampaignInputs({
    snapshotBytes: snapshot.bytes,
    splitManifestBytes: split.bytes,
    affectedRoutes,
    objectivePreset: "more-tasks-succeed@1",
    baselineArm: `current-${input.currentLoadout.treeDigest.slice("sha256:".length, "sha256:".length + 12)}`,
    candidateArm: `candidate-${input.candidateLoadout.treeDigest.slice("sha256:".length, "sha256:".length + 12)}`,
    replicates: 1,
    candidatePayloadRisks: candidatePayload.classes,
  });
  const promotionGroupIds = [...split.manifest.assignments.promotion];
  const memberIds = promotionGroupIds.flatMap((groupId) => {
    const group = split.manifest.groups.find((candidate) => candidate.groupId === groupId);
    if (group === undefined) refuse("invalid-document", "sweRebench.split", "promotion assignment names no sealed group");
    return group.members;
  });
  const entryById = new Map(split.manifest.poolSnapshot.entries.map((entry) => [entry.id, entry]));
  const promotionTaskDigests = memberIds.map((id) => {
    const entry = entryById.get(id);
    if (entry === undefined) refuse("invalid-document", "sweRebench.split", "promotion group names no sealed pool entry");
    return entry.taskDigest;
  });
  const promotionBenchmark = sealBenchmark({
    protocol: BENCHMARKING_PROTOCOL,
    name: "Jinn local SWE-rebench confirmation",
    description: "Fresh public SWE-rebench groups comparing one operator-frozen policy change with the current policy.",
    author: "urn:jinn:policy-optimization:local-operator",
    version: "1.0.0",
    items: promotionTaskDigests.map((digest) => ({
      task: { digest: { sha256: digest.slice("sha256:".length) } },
    })),
    reveal: { policy: "after-run" },
  });
  const currentTuple = snapshot.snapshot.seed.tuple;
  const candidateTuple = {
    ...currentTuple,
    loadout: (routeRequirements(input, harness, input.candidateLoadout.treeDigest) as Record<string, JsonValue>)["loadout"]!,
  };
  const runPlanBytes = canonicalJsonBytes({
    formatToken: LOCAL_SWE_REBENCH_RUN_PLAN_FORMAT_TOKEN,
    campaignDigest: campaign.digest,
    candidate: {
      archiveDigest: input.candidateLoadout.archiveDigest,
      treeDigest: input.candidateLoadout.treeDigest,
    },
    current: {
      archiveDigest: input.currentLoadout.archiveDigest,
      treeDigest: input.currentLoadout.treeDigest,
    },
    policyTuples: {
      candidate: tupleDigest(candidateTuple),
      current: tupleDigest(currentTuple),
    },
    promotionBenchmarkDigest: promotionBenchmark.digest,
    route: {
      affectedRoutes,
      harness,
      isolationPolicy: input.isolationPolicy,
      model: input.model,
      name: input.routeName,
    },
    hostImplementations: {
      evaluatorMethodDigest: `sha256:${LOCAL_SWE_REBENCH_EVALUATION_METHOD.digest.sha256}`,
      solverWrapperDigest: liveSolverWrapperDigest(),
    },
    pool: entries.map((entry) => ({
      evaluationSpecDigest: entry.evaluationSpecDigest,
      receiptDigest: entry.receiptDigest,
      taskDigest: entry.taskDigest,
    })),
    snapshotDigest: snapshot.digest,
    source: { config, dataset: SWE_REBENCH_DATASET, split: splitName },
    splitManifestDigest: split.digest,
  } as unknown as JsonValue);
  const runPlan = { bytes: runPlanBytes, digest: prefixedDigest(runPlanBytes) };
  return {
    campaign,
    snapshot,
    split,
    currentPayload,
    candidatePayload,
    runPlan,
    promotionBenchmark: { bytes: promotionBenchmark.bytes, digest: promotionBenchmark.digest },
    source: {
      dataset: SWE_REBENCH_DATASET,
      config,
      split: splitName,
      selectedInstances: selected.map(({ row }) => row.instance_id),
    },
    persist: () => persistPrepared({
      stateRoot: input.stateRoot,
      campaign,
      snapshot,
      split,
      pool: entries,
      receipts,
      currentLoadout: input.currentLoadout,
      candidateLoadout: input.candidateLoadout,
      runPlan,
      promotionBenchmark: { bytes: promotionBenchmark.bytes, digest: promotionBenchmark.digest },
      promotionGroupIds,
    }),
  };
}
