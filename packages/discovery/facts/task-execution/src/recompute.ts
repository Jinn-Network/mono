import {
  DeliveryRecordSchema,
  SubmissionRecordSchema,
  TaskSpecificationSchema,
} from "@jinn-network/task-execution-protocol";
import { EvaluationSpecSchema, TaskProfileDocumentSchema } from "@jinn-network/task-execution-profiles";
import { RECORD_KINDS } from "@jinn-network/record-discovery-protocol";
import type { FactsRecompute, RecordFactRecompute, RecordFactValue } from "@jinn-network/record-discovery-protocol";

// Record-fact recompute (design §5.4, §10.4 step 2, program §7.13): each
// function recomputes its kind's record facts from the record's own sealed
// BYTES -- decoded and validated through the SAME zod schemas the defining
// packages export (`@jinn-network/task-execution-protocol` for Task /
// Submission / Delivery; `@jinn-network/task-execution-profiles` for the
// profile-document / evaluation-spec kinds) -- never from a supplied
// projection. A non-conforming record (malformed bytes, invalid UTF-8,
// unparsable JSON, or a schema rejection) recomputes to no facts at all
// (`{}`), which `factsConsistency` (protocol) turns into `indeterminate` for
// every announced field -- never silently `consistent` (plan Task 13 Step
// 2, mirroring the facts/evidence and facts/trust leaves).
//
// Dependency note (deviation from the plan's literal package.json sketch,
// flagged in the implementer's findings): the plan's Task 24 interfaces
// section lists `@jinn-network/task-execution-profiles` as "the single
// record-kind-tree dependency for all seven kinds," but `task-execution-
// profiles`' public surface (`src/index.ts`) does not re-export Task /
// Submission / Delivery's zod schemas or validators -- those are owned by
// `@jinn-network/task-execution-protocol` (TEP §7/§8/§11) and are not
// re-exported by profiles. This leaf's own assignment brief names BOTH
// "task-execution-protocol/profiles validators" as the intended recompute
// mechanism, which is unreachable with a profiles-only dependency. This
// leaf therefore declares BOTH packages as direct production dependencies
// (see package.json) -- both live under `packages/task-execution/`, the
// one record-kind tree program §6.5 grants this leaf, and
// task-execution-profiles already depends on task-execution-protocol
// itself, so this adds no new tree edge, only a second direct import
// within the same tree.

const decoder = new TextDecoder("utf-8", { fatal: true });

/** Decode-then-JSON.parse; returns `undefined` (never throws) on any failure. */
function parseJson(bytes: Uint8Array): unknown {
  let text: string;
  try {
    text = decoder.decode(bytes);
  } catch {
    return undefined;
  }
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function noFacts(): Record<string, never> {
  return {};
}

/** `sha256:<hex>` form of a ResourceDescriptor digest-map's `sha256` entry, if present. */
function prefixedSha256(digest: Record<string, string> | undefined): `sha256:${string}` | undefined {
  const hex = digest?.["sha256"];
  return hex !== undefined ? (`sha256:${hex}` as const) : undefined;
}

/** Reads a string-typed value out of a loose/namespaced bag, else `undefined`. */
function stringField(bag: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = bag?.[key];
  return typeof value === "string" ? value : undefined;
}

// --- Task (TEP §7) --------------------------------------------------------

export const taskRecompute: RecordFactRecompute = async (bytes) => {
  const json = parseJson(bytes);
  if (json === undefined) return noFacts();
  const result = TaskSpecificationSchema.safeParse(json);
  if (!result.success) return noFacts();
  const task = result.data;
  return {
    profileUri: task.profile.uri,
    profileDigest: prefixedSha256(task.profile.digest),
    author: task.author,
    evaluationDigest: prefixedSha256(task.evaluation?.digest),
    supersedesDigest: prefixedSha256(task.supersedes?.digest),
  };
};

// --- Submission (TEP §8) ---------------------------------------------------
//
// `taskProfileUri` is drawn from the REFERENCED Task's bytes (design §5.4:
// "a Submission card includes facts drawn from its Task"), fetched through
// the injected `refs` port -- unavailable/capability-gated referenced bytes
// recompute to `undefined` for that one field, driving `indeterminate` for
// it alone (the other Submission-native fields still recompute normally).
// `terms` is declared `substrate`-class in the facts profile (marketplace-
// projection-only, design §6.3) and is therefore never produced here --
// `factsConsistency` (protocol) never asks a record-fact recompute fn for a
// substrate-classed field.
//
// `benchrun`/`benchcell`/`bencharm` (Addendum 2026-07-28-b, benchmarking
// design §7.3/§11): copied from the Submission's own "benchmarking
// extension block" `{ run, cellKey, armId, replicate, dispatch }`. Exact
// wire placement is not pinned by any spec this implementer could locate;
// this leaf reads them from `submission.annotations` (`annotations.run`,
// `annotations.cellKey`, `annotations.armId`), grounded in TEP
// `schemas/submission.ts`'s own doc comment naming `runId`/`cellKey` as
// example correlation-annotation content (carried amendment 3). Flagged as
// an assumption in the implementer's findings for program-gate
// confirmation -- absent (as on every non-benchmarking Submission) these
// three fields simply recompute to `undefined` and, per §5.4/§15's
// unknown/unannounced-field skip, are never checked unless announced.
export const submissionRecompute: RecordFactRecompute = async (bytes, refs) => {
  const json = parseJson(bytes);
  if (json === undefined) return noFacts();
  const result = SubmissionRecordSchema.safeParse(json);
  if (!result.success) return noFacts();
  const submission = result.data;

  const taskDigest = prefixedSha256(submission.task.digest);
  let taskProfileUri: string | undefined;
  if (taskDigest !== undefined) {
    const taskBytes = await refs.fetch(taskDigest);
    if (taskBytes !== undefined) {
      const taskJson = parseJson(taskBytes);
      const taskResult = taskJson === undefined ? undefined : TaskSpecificationSchema.safeParse(taskJson);
      if (taskResult?.success) taskProfileUri = taskResult.data.profile.uri;
    }
  }

  const annotations = submission.annotations as Record<string, unknown> | undefined;
  return {
    taskDigest,
    taskProfileUri,
    requesterIri: submission.requester,
    deadline: submission.deadline,
    benchrun: stringField(annotations, "run"),
    benchcell: stringField(annotations, "cellKey"),
    bencharm: stringField(annotations, "armId"),
  };
};

// --- Delivery (TEP §11) -----------------------------------------------------
//
// `benchrun`/`benchcell`/`bencharm`: DeliveryRecordSchema has no
// `annotations` bucket (unlike Submission), but it is `.loose()` -- open to
// namespaced top-level extensions (§21.3). This leaf reads the same three
// key names as top-level fields directly on the Delivery's own bytes
// (`run`/`cellKey`/`armId`), read from the parsed JSON rather than the
// zod-validated result to sidestep the schema's lack of a declared type for
// them. Same assumption-flag as the Submission side above.
export const deliveryRecompute: RecordFactRecompute = async (bytes) => {
  const json = parseJson(bytes);
  if (json === undefined) return noFacts();
  const result = DeliveryRecordSchema.safeParse(json);
  if (!result.success) return noFacts();
  const delivery = result.data;
  const record = json as Record<string, unknown>;
  return {
    taskDigest: delivery.task,
    attemptUri: delivery.attempt,
    outcome: delivery.outcome,
    benchrun: stringField(record, "run"),
    benchcell: stringField(record, "cellKey"),
    bencharm: stringField(record, "armId"),
  };
};

// --- Profile document (profiles design §6.1) --------------------------------

export const profileDocumentRecompute: RecordFactRecompute = async (bytes) => {
  const json = parseJson(bytes);
  if (json === undefined) return noFacts();
  const result = TaskProfileDocumentSchema.safeParse(json);
  if (!result.success) return noFacts();
  const doc = result.data;
  return {
    profile: doc.profile,
    extendsDigest: doc.extends?.digest as RecordFactValue,
  };
};

// --- Evaluation spec (profiles design §7.1) ----------------------------------

export const evaluationSpecRecompute: RecordFactRecompute = async (bytes) => {
  const json = parseJson(bytes);
  if (json === undefined) return noFacts();
  const result = EvaluationSpecSchema.safeParse(json);
  if (!result.success) return noFacts();
  return { family: result.data.family };
};

// --- Plugin / checkpoint artifacts (design §12 last row) --------------------
//
// GENUINE GAP (implementer finding, flagged for the program gate): as of
// this worktree's HEAD, no defining-bytes schema exists anywhere in
// `@jinn-network/task-execution-protocol` or `@jinn-network/task-execution-
// profiles` (nor any other in-tree package) for a "plugin artifact" or a
// "checkpoint artifact" record. Both RECORD_KINDS URIs are already pinned
// in discovery/protocol/identifiers.ts, and this leaf structurally
// registers a facts profile + a `FactsRecompute` entry for each -- required
// by program §6.5's "single leaf, seven kinds" mandate -- but with ZERO
// declared fields and a recompute fn that always returns no facts. This is
// deliberately honest rather than inventing unbacked field names: an empty
// facts profile asserts nothing, so nothing can be inconsistent, and no
// consumer is misled into filtering on a fabricated schema. When a real
// plugin/checkpoint artifact schema lands in the task-execution tree, this
// leaf's two profile documents + recompute fns are the place to fill in.
export const pluginRecompute: RecordFactRecompute = async () => noFacts();
export const checkpointRecompute: RecordFactRecompute = async () => noFacts();

// --- v2 revisions (join-edge completeness, protocol design §12 amendment 2026-08-28) --------
//
// A ResourceDescriptor is satisfiable by `uri` or inline `content` alone (§6.4). Only the
// digest-bearing ones pin anything, so only those are edges; a uri-only input or output names a
// location, not a record, and is not carried. Both fns keep v1's every field.

/** A digest-bearing descriptor's `sha256`, in the prefixed spelling the cards carry. */
function descriptorDigest(value: unknown): `sha256:${string}` | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const digest = (value as { digest?: Record<string, string> }).digest;
  return prefixedSha256(digest);
}

/** The digest-bearing members of a descriptor list, in record order. */
function descriptorListDigests(value: unknown): `sha256:${string}`[] {
  if (!Array.isArray(value)) return [];
  const digests: `sha256:${string}`[] = [];
  for (const entry of value) {
    const digest = descriptorDigest(entry);
    if (digest !== undefined) digests.push(digest);
  }
  return digests;
}

/**
 * v1's card plus the inputs the Task pins and the output JSON Schemas its slots pin. `outputs` is
 * a closed array of a closed slot object, and a slot's `schema` is the same optional-digest
 * descriptor `profile-document.v2` carries for `outputConventions.slots[].schema` -- so the two
 * kinds answer "which records pin schema `sha256:X`" the same way rather than disagreeing about a
 * structurally identical field. An embedded schema carries no digest and is not an edge, which
 * `descriptorListDigests` already handles by skipping any entry without one.
 */
export const taskRecomputeV2: RecordFactRecompute = async (bytes, refs) => {
  const facts = await taskRecompute(bytes, refs);
  if (Object.keys(facts).length === 0) return noFacts();
  const result = TaskSpecificationSchema.safeParse(parseJson(bytes));
  if (!result.success) return noFacts();
  return {
    ...facts,
    inputDigests: descriptorListDigests(result.data.inputs),
    outputSlotSchemaDigests: descriptorListDigests(
      result.data.outputs.map((slot) => slot.schema),
    ),
  };
};

export const deliveryRecomputeV2: RecordFactRecompute = async (bytes, refs) => {
  const facts = await deliveryRecompute(bytes, refs);
  if (Object.keys(facts).length === 0) return noFacts();
  const result = DeliveryRecordSchema.safeParse(parseJson(bytes));
  if (!result.success) return noFacts();
  const delivery = result.data;
  return {
    ...facts,
    resultDigests: descriptorListDigests(delivery.outputs),
    evidenceDigests: (delivery.evidenceRecords ?? []).map((reference) => reference.digest),
    ...(delivery.supersedes === undefined ? {} : { supersedesDigest: delivery.supersedes }),
  };
};

/** The leaf's `FactsRecompute` registry entry (program §7.13): the host
 * assembles the tree-wide registry by merging each leaf's export. */
export const TASK_EXECUTION_FACTS_RECOMPUTE: FactsRecompute = {
  get(kind: string): RecordFactRecompute | undefined {
    switch (kind) {
      case RECORD_KINDS.task:
        return taskRecompute;
      case RECORD_KINDS.submission:
        return submissionRecompute;
      case RECORD_KINDS.delivery:
        return deliveryRecompute;
      case RECORD_KINDS.profileDocument:
        return profileDocumentRecompute;
      case RECORD_KINDS.evaluationSpec:
        return evaluationSpecRecompute;
      case RECORD_KINDS.plugin:
        return pluginRecompute;
      case RECORD_KINDS.checkpoint:
        return checkpointRecompute;
      default:
        return undefined;
    }
  },
};

/**
 * The ABIs a state-predicate spec reads through, from every declarative call target its success
 * predicates name -- a `callResult` predicate's own call, and a `reportedValue` predicate's
 * ground-truth call. The read key a consumer derives is a function of the ABI digest, so two
 * specs reading one function through different ABIs are different specs, and "which specs read
 * against ABI sha256:X" is the question asked when an ABI turns out to be wrong. An
 * `encodedCall` target names no ABI and contributes nothing.
 *
 * `successPredicates` is the whole reachable set, not the first list that matched. A block's
 * other two predicate lists cannot carry a call target: `safetyConstraints` is restricted by
 * `SAFETY_CONSTRAINT_KINDS` to five kinds that read no state through an ABI, and the block's
 * `measurements` use the observation vocabulary, whose `reportedValue` variant carries a name
 * and nothing else. `recompute.test.ts` pins the first of those by construction.
 */
function abiRefDigests(predicates: readonly unknown[]): `sha256:${string}`[] {
  const seen = new Set<string>();
  const digests: `sha256:${string}`[] = [];
  for (const predicate of predicates) {
    if (typeof predicate !== "object" || predicate === null) continue;
    const bag = predicate as { call?: unknown; groundTruth?: { call?: unknown } };
    for (const target of [bag.call, bag.groundTruth?.call]) {
      if (typeof target !== "object" || target === null) continue;
      const digest = descriptorDigest((target as { abiRef?: unknown }).abiRef);
      if (digest === undefined || seen.has(digest)) continue;
      seen.add(digest);
      digests.push(digest);
    }
  }
  return digests;
}

/**
 * v1's `family` plus every component the spec pins by digest. Which of them a given spec carries
 * is decided by its family: only a state-predicate block names an environment record and the ABIs
 * its predicates read through, only a deterministic-process block names an image, test material
 * and a parser, and so on. A scalar edge the spec's family does not have is not announced at all;
 * a list edge its family *does* have is announced even when empty, because "this spec pins no
 * test material" is a true statement recomputed from the record, while an absent scalar is not a
 * statement at all.
 *
 * `grader` is one descriptor or a list of them, and is the access-classified case the
 * completeness rule leads with: a private grader's bytes are exactly what a consumer cannot
 * retrieve, so if the card does not name it, nothing can join on it.
 */
export const evaluationSpecRecomputeV2: RecordFactRecompute = async (bytes, refs) => {
  const facts = await evaluationSpecRecompute(bytes, refs);
  if (Object.keys(facts).length === 0) return noFacts();
  const result = EvaluationSpecSchema.safeParse(parseJson(bytes));
  if (!result.success) return noFacts();
  const spec = result.data;
  const block = (spec.familyBlock ?? {}) as Record<string, unknown>;
  const graders = Array.isArray(spec.grader) ? spec.grader : [spec.grader];
  const edges: Record<string, RecordFactValue> = {
    ...facts,
    graderDigests: descriptorListDigests(graders),
  };
  const add = (name: string, value: RecordFactValue | undefined): void => {
    if (value !== undefined) edges[name] = value;
  };
  add("environmentRecordDigest", descriptorDigest(block.environmentRecord));
  if (Array.isArray(block.successPredicates)) {
    edges.abiRefDigests = abiRefDigests(block.successPredicates);
  }
  add("imageDigest", descriptorDigest(block.image));
  if (Array.isArray(block.testMaterial)) {
    edges.testMaterialDigests = descriptorListDigests(block.testMaterial);
  }
  add("parserDigest", (block.parser as { digest?: string } | undefined)?.digest);
  add("rubricDigest", descriptorDigest(block.rubric));
  add("judgeOutputSchemaDigest", descriptorDigest(block.judgeOutputSchema));
  add("reviewFormDigest", descriptorDigest(block.reviewForm));
  if (Array.isArray(block.subSpecs)) {
    edges.subSpecDigests = descriptorListDigests(
      block.subSpecs.map((sub) => (sub as { spec?: unknown }).spec),
    );
  }
  return edges;
};

/**
 * v1's card plus the output-slot schemas a profile pins. v1 declared only `extends`, but a slot's
 * `schema` is the same optional-digest ResourceDescriptor this leaf already treats as an edge on
 * an evaluation spec: satisfiable by a `uri` alone under §6.4, in which case it pins nothing and
 * is not carried, and an edge when it does carry a digest. "Which profiles validate output
 * against schema `sha256:X`" is the query a wrong schema makes someone ask.
 */
export const profileDocumentRecomputeV2: RecordFactRecompute = async (bytes, refs) => {
  const facts = await profileDocumentRecompute(bytes, refs);
  if (Object.keys(facts).length === 0) return noFacts();
  const result = TaskProfileDocumentSchema.safeParse(parseJson(bytes));
  if (!result.success) return noFacts();
  return {
    ...facts,
    outputSlotSchemaDigests: descriptorListDigests(
      result.data.outputConventions.slots.map((slot) => (slot as { schema?: unknown }).schema),
    ),
  };
};

/** Explicit registry for the coexisting Task-Execution facts v2 profiles. */
export const TASK_EXECUTION_FACTS_RECOMPUTE_V2: FactsRecompute = {
  get(kind: string): RecordFactRecompute | undefined {
    switch (kind) {
      case RECORD_KINDS.task:
        return taskRecomputeV2;
      case RECORD_KINDS.delivery:
        return deliveryRecomputeV2;
      case RECORD_KINDS.evaluationSpec:
        return evaluationSpecRecomputeV2;
      case RECORD_KINDS.profileDocument:
        return profileDocumentRecomputeV2;
      default:
        return TASK_EXECUTION_FACTS_RECOMPUTE.get(kind);
    }
  },
};
