// SPDX-License-Identifier: MIT

import { existsSync, lstatSync, readdirSync, realpathSync } from "node:fs";
import { join } from "node:path";
import {
  canonicalJsonBytes,
  expressAsRunPinning,
  prefixedDigest,
  tupleDigest,
  type ExecutionPolicyTuple,
  type JsonValue,
} from "@jinn-network/policy-identity";
import {
  adoptionConfigFragment,
  emptyAdoptionLog,
  prepareAdoption,
  sortAdoptionComponentClasses,
} from "../archive/adoption.js";
import { archiveLayout, defaultArchiveRoot, parseAdoptionLog } from "../archive/store.js";
import type {
  AdoptionComponentClass,
  AdoptionLog,
  AdoptionRecord,
  AdoptionScope,
} from "../archive/types.js";
import { classifyPayload } from "../admission/payload-class.js";
import { parseExactNextRunPolicySnapshot } from "../next-run-policy-snapshot.js";
import { projectRecommendation, type RecommendationDecision } from "../recommendation.js";
import { declaredBaselineRevision } from "./declared-baseline.js";
import { parseExactLiveCampaignInputs } from "./live-campaign-parse.js";
import { parseLocalRunPlan } from "./live-swe-rebench-runner.js";
import {
  parseLocalLoadoutArchive,
  sealLocalLoadoutDirectory,
  type SealedLocalLoadoutArchive,
} from "./loadout-archive.js";
import { HostStateError, secureAtomicWrite, secureRead } from "./state.js";

export const LOCAL_ADOPTION_PLAN_FORMAT_TOKEN =
  "network.jinn.policy-optimization.local-adoption-plan/1.0" as const;

export interface LocalAdoptionPreview {
  readonly recommendation: RecommendationDecision;
  readonly configRevision: string;
  readonly affectedScopes: readonly AdoptionScope[];
  readonly targetTupleDigest: string;
  readonly currentTupleDigest: string;
  readonly payloadClasses: readonly AdoptionComponentClass[];
}

export interface LocalAdoptionResult extends LocalAdoptionPreview {
  readonly sharedDecisionId: string;
  readonly records: readonly AdoptionRecord[];
  readonly planPath: string;
  readonly planDigest: string;
  readonly adoptionLogPath: string;
  readonly changes: readonly Readonly<Record<string, unknown>>[];
  readonly rollbacks: readonly Readonly<Record<string, unknown>>[];
}

export interface PrepareLocalCampaignAdoptionInput {
  readonly preparedRoot: string;
  /** The baseline directory explicitly supplied again by the operator at adoption time. */
  readonly currentLoadoutPath: string;
  /** Exact, complete route-set consent. Preview and confirmation both fail on partial consent. */
  readonly approvedRoutes: readonly string[];
  /** Exact challenger tuple consent. Optional for preview, mandatory for confirmation. */
  readonly approvedTupleDigest?: string;
  readonly approvedPayloadClasses: readonly AdoptionComponentClass[];
  readonly confirmed: boolean;
  readonly overrideInconclusive?: { readonly reason: string };
  readonly adoptedAt: string;
}

interface AdoptionContext extends LocalAdoptionPreview {
  readonly campaign: ReturnType<typeof parseExactLiveCampaignInputs>;
  readonly currentTuple: ExecutionPolicyTuple;
  readonly candidateTuple: ExecutionPolicyTuple;
  readonly currentLoadout: SealedLocalLoadoutArchive;
}

function fail(message: string): never {
  throw new HostStateError("state-io", message);
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function readSecureAdoptionLog(path: string): AdoptionLog {
  if (!existsSync(path)) return emptyAdoptionLog();
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(secureRead(path)));
  } catch {
    fail("private adoption log is invalid");
  }
  return parseAdoptionLog(value, "private adoption log");
}

function exactReportBytes(root: string): readonly Uint8Array[] {
  if (!existsSync(root)) fail("campaign has no exact recommendation Reports");
  const stat = lstatSync(root);
  if (stat.isSymbolicLink() || !stat.isDirectory()) fail("campaign Reports directory is unsafe");
  const names = readdirSync(root)
    .filter((name) => /^[a-f0-9]{64}\.json$/u.test(name))
    .sort();
  if (names.length === 0) fail("campaign has no exact recommendation Reports");
  return names.map((name) => {
    const bytes = secureRead(join(root, name));
    if (prefixedDigest(bytes).slice("sha256:".length) !== name.slice(0, -".json".length)) {
      fail("recommendation Report filename does not bind its exact bytes");
    }
    return bytes;
  });
}

function preparedLoadout(
  path: string,
  expected: { readonly archiveDigest: string; readonly treeDigest: string },
): SealedLocalLoadoutArchive {
  let parsed: SealedLocalLoadoutArchive;
  try { parsed = parseLocalLoadoutArchive(secureRead(path), "prepared-loadout"); }
  catch { fail("prepared loadout archive is invalid or moved"); }
  if (parsed.archiveDigest !== expected.archiveDigest || parsed.treeDigest !== expected.treeDigest) {
    fail("prepared loadout archive or tree binding moved");
  }
  return parsed;
}

function candidateTupleFrom(
  current: ExecutionPolicyTuple,
  candidateTreeDigest: string,
): ExecutionPolicyTuple {
  const loadout = current.loadout;
  if (typeof loadout !== "object" || loadout === null || Array.isArray(loadout)
    || loadout.kind !== "jinn.harness-state.v1" || typeof loadout.name !== "string") {
    fail("declared baseline tuple has no adoptable public learner loadout");
  }
  const candidate = {
    ...current,
    loadout: { ...loadout, digest: candidateTreeDigest },
  } as ExecutionPolicyTuple;
  tupleDigest(candidate);
  return candidate;
}

const TREE_ADOPTION_CLASS: Readonly<Record<string, AdoptionComponentClass>> = {
  ".archive": "prompt",
  agents: "skill",
  configs: "tool-config",
  hooks: "hook",
  notes: "prompt",
  patterns: "prompt",
  plans: "prompt",
  "policy.json": "prompt",
  runs: "prompt",
  skills: "skill",
  strategies: "prompt",
  tests: "hook",
  tools: "tool-config",
  tunables: "prompt",
};

/** Map the exact admitted tree—not a synthesized CandidateManifest—onto adoption consent classes. */
function treeAdoptionClasses(
  entries: SealedLocalLoadoutArchive["entries"],
): readonly AdoptionComponentClass[] {
  return sortAdoptionComponentClasses(entries.map((entry) => {
    const root = entry.path.split("/", 1)[0]!.toLowerCase();
    return TREE_ADOPTION_CLASS[root] ?? "unclassified";
  }));
}

function approvedScopes(
  campaign: ReturnType<typeof parseExactLiveCampaignInputs>,
  approvedRoutes: readonly string[],
): readonly AdoptionScope[] {
  const expected = campaign.affectedRoutes.map((entry) => entry.route ?? fail("affected route is unnamed"));
  const approved = [...new Set(approvedRoutes)];
  if (approved.some((route) => route.length === 0 || route.includes("\0"))) {
    fail("explicit affected-route consent is invalid");
  }
  approved.sort();
  if (!sameStrings(approved, expected)) {
    fail("explicit affected-route consent must name the complete operator-declared shared-loadout route set");
  }
  return campaign.affectedRoutes.map((entry) => ({
    taskProfile: entry.taskProfile,
    route: entry.route!,
  }));
}

function adoptionContext(input: PrepareLocalCampaignAdoptionInput): AdoptionContext {
  let preparedRoot: string;
  try {
    if (!existsSync(input.preparedRoot) || lstatSync(input.preparedRoot).isSymbolicLink()) {
      fail("prepared campaign root is unavailable or unsafe");
    }
    preparedRoot = realpathSync(input.preparedRoot);
  } catch (cause) {
    if (cause instanceof HostStateError) throw cause;
    fail("prepared campaign root is unavailable or unsafe");
  }
  if (!existsSync(join(preparedRoot, "run", "recommendation.json"))) {
    fail("campaign has not produced a recommendation");
  }
  const campaignBytes = secureRead(join(preparedRoot, "campaign-inputs.json"));
  const campaign = parseExactLiveCampaignInputs(campaignBytes);
  const snapshotBytes = secureRead(join(preparedRoot, "next-run-policy-snapshot.json"));
  const snapshot = parseExactNextRunPolicySnapshot(snapshotBytes);
  const runPlan = parseLocalRunPlan(join(preparedRoot, "run-plan.json"));
  if (prefixedDigest(campaignBytes) !== runPlan.plan.campaignDigest
    || prefixedDigest(snapshotBytes) !== runPlan.plan.snapshotDigest
    || campaign.snapshotDigest !== runPlan.plan.snapshotDigest
    || campaign.configRevision !== snapshot.configRevision
    || !sameStrings(
      campaign.affectedRoutes.map((entry) => `${entry.taskProfile}\0${entry.route ?? ""}`),
      runPlan.plan.route.affectedRoutes.map((entry) => `${entry.taskProfile}\0${entry.route ?? ""}`),
    )) {
    fail("campaign, declared baseline snapshot, route set, or run plan binding moved");
  }

  const preparedCurrent = preparedLoadout(join(preparedRoot, "loadout-current.json"), runPlan.plan.current);
  const currentLoadout = sealLocalLoadoutDirectory(input.currentLoadoutPath);
  if (currentLoadout.archiveDigest !== preparedCurrent.archiveDigest
    || currentLoadout.treeDigest !== preparedCurrent.treeDigest) {
    fail("the explicitly supplied baseline loadout moved after campaign preparation");
  }
  const recomputedRevision = declaredBaselineRevision({
    route: snapshot.route,
    affectedRoutes: campaign.affectedRoutes,
    profileDigest: snapshot.inputs.profile.digest,
    harness: {
      id: runPlan.plan.route.harness.id,
      executable: runPlan.plan.route.harness.executable,
      digest: runPlan.plan.route.harness.digest,
      version: runPlan.plan.route.harness.version,
    },
    model: runPlan.plan.route.model,
    isolationPolicy: runPlan.plan.route.isolationPolicy,
    loadout: {
      archiveDigest: currentLoadout.archiveDigest,
      treeDigest: currentLoadout.treeDigest,
    },
    requirements: expressAsRunPinning(snapshot.seed.tuple) as JsonValue,
  });
  if (recomputedRevision !== snapshot.configRevision) {
    fail("the complete declared baseline moved after campaign preparation");
  }

  const candidateLoadout = preparedLoadout(
    join(preparedRoot, "loadout-candidate.json"),
    runPlan.plan.candidate,
  );
  const candidatePayload = classifyPayload(candidateLoadout.entries, "jinn.harness-state.v1");
  if (!sameStrings([...candidatePayload.classes], [...campaign.candidatePayloadRisks])) {
    fail("candidate payload-risk classification moved after campaign preparation");
  }
  const candidateTuple = candidateTupleFrom(snapshot.seed.tuple, candidateLoadout.treeDigest);
  const targetTupleDigest = tupleDigest(candidateTuple);
  if (snapshot.seed.digest !== runPlan.plan.policyTuples.current
    || targetTupleDigest !== runPlan.plan.policyTuples.candidate) {
    fail("prepared current or challenger tuple binding moved");
  }
  if (input.approvedTupleDigest !== undefined && input.approvedTupleDigest !== targetTupleDigest) {
    fail("explicit tuple consent does not match the evaluated challenger");
  }

  const recommendation = projectRecommendation({
    objectivePreset: campaign.objectivePreset,
    objective: campaign.objective,
    currentTupleDigest: snapshot.seed.digest,
    challengerTupleDigest: targetTupleDigest,
    runBytes: secureRead(join(preparedRoot, "run", "promotion-run.json")),
    matrixBytes: secureRead(join(preparedRoot, "run", "matrix.json")),
    reportBytes: exactReportBytes(join(preparedRoot, "run", "reports")),
  });
  return {
    campaign,
    recommendation,
    configRevision: snapshot.configRevision,
    affectedScopes: approvedScopes(campaign, input.approvedRoutes),
    targetTupleDigest,
    currentTupleDigest: snapshot.seed.digest,
    payloadClasses: treeAdoptionClasses(candidateLoadout.entries),
    currentTuple: snapshot.seed.tuple,
    candidateTuple,
    currentLoadout,
  };
}

function decisionId(input: {
  readonly resolved: AdoptionContext;
  readonly adoptedAt: string;
  readonly approvedPayloadClasses: readonly AdoptionComponentClass[];
  readonly overrideReason?: string;
}): string {
  return prefixedDigest(canonicalJsonBytes({
    adoptedAt: input.adoptedAt,
    affectedScopes: input.resolved.affectedScopes,
    baselineRevision: input.resolved.configRevision,
    currentTupleDigest: input.resolved.currentTupleDigest,
    domain: "network.jinn.policy-optimization.local-adoption-decision/1.0",
    overrideReason: input.overrideReason ?? null,
    payloadClassesApproved: [...new Set(input.approvedPayloadClasses)].sort(),
    recommendationBasis: input.resolved.recommendation.basis,
    targetTupleDigest: input.resolved.targetTupleDigest,
  } as unknown as JsonValue));
}

/**
 * Recomputes the recommendation and baseline from exact local bytes, then prepares a canonical
 * change/rollback artifact. It never reads or mutates an operator product or destination.
 */
export function prepareLocalCampaignAdoption(
  input: PrepareLocalCampaignAdoptionInput,
): LocalAdoptionPreview | LocalAdoptionResult {
  const resolved = adoptionContext(input);
  if (!input.confirmed) return resolved;
  if (input.approvedTupleDigest === undefined) {
    fail("confirmed adoption requires explicit consent to the exact challenger tuple digest");
  }
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/u.test(input.adoptedAt)
    || Number.isNaN(Date.parse(input.adoptedAt))) {
    fail("adoption time must be an RFC 3339 instant with an offset");
  }
  const preparedRoot = realpathSync(input.preparedRoot);
  const layout = archiveLayout(defaultArchiveRoot(preparedRoot));
  const adoptionLog = readSecureAdoptionLog(layout.adoptionPath);
  const sharedDecisionId = decisionId({
    resolved,
    adoptedAt: input.adoptedAt,
    approvedPayloadClasses: input.approvedPayloadClasses,
    ...(input.overrideInconclusive === undefined
      ? {}
      : { overrideReason: input.overrideInconclusive.reason.trim() }),
  });
  let stagedLog = adoptionLog;
  const records: AdoptionRecord[] = [];
  for (const scope of resolved.affectedScopes) {
    const preparedRecord = prepareAdoption({
      log: stagedLog,
      scope,
      tupleDigest: resolved.targetTupleDigest,
      requires: resolved.payloadClasses,
      approved: input.approvedPayloadClasses,
      adoptedAt: input.adoptedAt,
      recommendation: resolved.recommendation,
      baseConfigurationRevision: resolved.configRevision,
      currentConfigurationRevision: resolved.configRevision,
      routePayloadConsent: true,
      explicitConfirmation: true,
      ...(input.overrideInconclusive === undefined
        ? {}
        : { overrideInconclusive: {
            warningAcknowledged: true as const,
            reason: input.overrideInconclusive.reason,
          } }),
    });
    const record: AdoptionRecord = {
      ...preparedRecord,
      recommendationBasis: {
        runDigest: resolved.recommendation.basis.runDigest,
        matrixDigest: resolved.recommendation.basis.matrixDigest,
        reportDigests: [...resolved.recommendation.basis.reportDigests],
        methodRefs: resolved.recommendation.basis.methodRefs.map((method) => ({
          id: method.id,
          version: method.version,
          parameters: { ...method.parameters },
        })),
      },
      sharedDecisionId,
    };
    records.push(record);
    stagedLog = { ...stagedLog, records: [...stagedLog.records, record] };
  }
  const changes = records.map((record) => adoptionConfigFragment(record, resolved.candidateTuple));
  const rollbacks = records.map((record) => adoptionConfigFragment(
    { ...record, tupleDigest: resolved.currentTupleDigest },
    resolved.currentTuple,
  ));
  const planBytes = canonicalJsonBytes({
    affectedRouteScopes: resolved.affectedScopes,
    baseline: {
      configRevision: resolved.configRevision,
      expectedCurrentTupleDigest: resolved.currentTupleDigest,
      loadoutArchiveDigest: resolved.currentLoadout.archiveDigest,
      loadoutTreeDigest: resolved.currentLoadout.treeDigest,
      source: "operator-declared-not-live-destination-state",
    },
    changes,
    consent: {
      records,
      payloadClassesApproved: [...new Set(input.approvedPayloadClasses)].sort(),
      routeSetCompleteness: "operator-declared-cannot-be-independently-proven",
    },
    effect: "prepared-only-no-daemon-mutation",
    formatToken: LOCAL_ADOPTION_PLAN_FORMAT_TOKEN,
    preconditions: [{
      expectedCurrentTupleDigest: resolved.currentTupleDigest,
      kind: "destination-current-tuple-must-equal",
      responsibility: "required-at-apply-time-not-checked-by-optimizer",
    }],
    recommendation: {
      basis: resolved.recommendation.basis,
      limitations: resolved.recommendation.limitations,
      reasonCodes: resolved.recommendation.reasonCodes,
      status: resolved.recommendation.status,
    },
    rollbacks,
    sharedDecisionId,
  } as unknown as JsonValue);
  const planDigest = prefixedDigest(planBytes);
  const planPath = join(
    preparedRoot,
    "run",
    "adoption-plans",
    `${planDigest.slice("sha256:".length)}.json`,
  );
  secureAtomicWrite(planPath, planBytes, true);
  // Every affected-route record is published by one atomic whole-log replacement.
  secureAtomicWrite(layout.adoptionPath, canonicalJsonBytes(stagedLog as unknown as JsonValue));
  return {
    ...resolved,
    sharedDecisionId,
    records,
    planPath,
    planDigest,
    adoptionLogPath: layout.adoptionPath,
    changes,
    rollbacks,
  };
}
