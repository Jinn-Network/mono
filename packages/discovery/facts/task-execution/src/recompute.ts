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
