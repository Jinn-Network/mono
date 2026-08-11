// SPDX-License-Identifier: MIT

import {
  canonicalJsonBytes,
  deriveExecutionTuple,
  prefixedDigest,
  tupleDigest,
  type ExecutionPolicyTuple,
  type ResolvedTaskProfile,
  type SealedSubmissionDoc,
  type SealedTaskDoc,
} from "@jinn-network/policy-identity";
import { refuse } from "./errors.js";

export const NEXT_RUN_POLICY_SNAPSHOT_FORMAT_TOKEN =
  "network.jinn.policy-optimization.next-run-policy-snapshot/1.0" as const;

export interface ExactPolicyInput {
  readonly bytes: Uint8Array;
  readonly digest: string;
}

export interface NextRunRoute {
  readonly taskProfile: string;
  readonly route?: string;
}

export interface NextRunPolicyResolution {
  readonly route: NextRunRoute;
  readonly task: ExactPolicyInput;
  readonly submission: ExactPolicyInput;
  readonly profile: ExactPolicyInput & {
    readonly profile: string;
    readonly requirementKeys: ResolvedTaskProfile["requirementKeys"];
  };
  /** Exact public `learner-public.v1` loadout archive/tree bytes. */
  readonly loadout: ExactPolicyInput;
}

export interface CaptureNextRunPolicySnapshotInput {
  /** Exactly one route resolution. Zero is missing and more than one is ambiguous. */
  readonly resolutions: readonly NextRunPolicyResolution[];
  /** One coherent revision must cover every byte read in this batch. */
  readonly configRevisionBefore: string;
  readonly configRevisionAfter: string;
}

export interface NextRunPolicySnapshot {
  readonly formatToken: typeof NEXT_RUN_POLICY_SNAPSHOT_FORMAT_TOKEN;
  readonly configRevision: string;
  readonly route: NextRunRoute;
  readonly inputs: {
    readonly task: { readonly digest: string; readonly bytesBase64: string };
    readonly submission: { readonly digest: string; readonly bytesBase64: string };
    readonly profile: {
      readonly digest: string;
      readonly bytesBase64: string;
      readonly profile: string;
      readonly requirementKeys: ResolvedTaskProfile["requirementKeys"];
    };
    readonly loadout: { readonly digest: string; readonly bytesBase64: string; readonly hashProfile: "learner-public.v1" };
  };
  readonly seed: { readonly kind: "tuple"; readonly digest: string; readonly tuple: ExecutionPolicyTuple };
  readonly diagnostics: readonly [];
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length && left.every((byte, index) => byte === right[index]);
}

function exactJson<T>(input: ExactPolicyInput, path: string): T {
  if (!(input.bytes instanceof Uint8Array) || input.bytes.length === 0) {
    refuse("invalid-document", `${path}.bytes`, "exact bytes are required; the host may not infer or reuse a prior document");
  }
  const actual = prefixedDigest(input.bytes);
  if (actual !== input.digest) {
    refuse("invalid-document", `${path}.digest`, `declared ${input.digest}, exact bytes digest to ${actual}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(input.bytes));
  } catch {
    refuse("invalid-document", `${path}.bytes`, "bytes must be UTF-8 JSON");
  }
  let canonical: Uint8Array;
  try {
    canonical = canonicalJsonBytes(parsed);
  } catch (cause) {
    refuse("invalid-document", `${path}.bytes`, `bytes are not I-JSON: ${String(cause)}`);
  }
  if (!bytesEqual(input.bytes, canonical)) {
    refuse("invalid-document", `${path}.bytes`, "bytes must be the exact canonical encoding (duplicate keys and alternate spellings are refused)");
  }
  return parsed as T;
}

const SECRET_MATERIAL = [
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/iu,
  /\b(?:api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|password)\b\s*[:=]/iu,
  /\bauthorization\b\s*[:=]\s*["']?bearer\s+/iu,
] as const;

function assertPublicLoadout(input: ExactPolicyInput): void {
  if (!(input.bytes instanceof Uint8Array) || input.bytes.length === 0) {
    refuse("invalid-document", "loadout.bytes", "public learner loadout bytes are required");
  }
  const actual = prefixedDigest(input.bytes);
  if (actual !== input.digest) {
    refuse("invalid-document", "loadout.digest", `declared ${input.digest}, exact bytes digest to ${actual}`);
  }
  const text = new TextDecoder("utf-8", { fatal: false }).decode(input.bytes);
  if (SECRET_MATERIAL.some((pattern) => pattern.test(text))) {
    refuse("invalid-document", "loadout.bytes", "learner-public.v1 material appears to contain a secret; refusing before execution");
  }
}

/**
 * Captures one coherent next-run policy batch and derives its tuple seed from the exact Task,
 * Submission, and pinned profile bytes. No CandidateManifest is invented and no execution
 * history is consulted.
 */
export function captureNextRunPolicySnapshot(
  input: CaptureNextRunPolicySnapshotInput,
): Readonly<NextRunPolicySnapshot> {
  if (input.resolutions.length !== 1) {
    refuse("invalid-document", "resolutions",
      input.resolutions.length === 0
        ? "the selected route has no next-run resolution"
        : `the selected route resolved ${input.resolutions.length} policies; the next run is ambiguous`);
  }
  if (input.configRevisionBefore.length === 0 || input.configRevisionBefore !== input.configRevisionAfter) {
    refuse("invalid-document", "configRevision",
      `configuration moved during capture (${input.configRevisionBefore || "missing"} -> ${input.configRevisionAfter || "missing"})`);
  }

  const resolution = input.resolutions[0]!;
  const task = exactJson<SealedTaskDoc>(resolution.task, "task");
  const submission = exactJson<SealedSubmissionDoc>(resolution.submission, "submission");
  exactJson<unknown>(resolution.profile, "profile");
  assertPublicLoadout(resolution.loadout);
  const profile: ResolvedTaskProfile = {
    profile: resolution.profile.profile,
    sealedBytes: Buffer.from(resolution.profile.bytes).toString("base64"),
    requirementKeys: resolution.profile.requirementKeys,
  };
  const tuple = deriveExecutionTuple(task, submission, profile);
  const encode = (value: ExactPolicyInput) => ({
    digest: value.digest,
    bytesBase64: Buffer.from(value.bytes).toString("base64"),
  });
  const snapshot: NextRunPolicySnapshot = {
    formatToken: NEXT_RUN_POLICY_SNAPSHOT_FORMAT_TOKEN,
    configRevision: input.configRevisionBefore,
    route: {
      taskProfile: resolution.route.taskProfile,
      ...(resolution.route.route === undefined ? {} : { route: resolution.route.route }),
    },
    inputs: {
      task: encode(resolution.task),
      submission: encode(resolution.submission),
      profile: {
        ...encode(resolution.profile),
        profile: resolution.profile.profile,
        requirementKeys: resolution.profile.requirementKeys,
      },
      loadout: { ...encode(resolution.loadout), hashProfile: "learner-public.v1" },
    },
    seed: { kind: "tuple", digest: tupleDigest(tuple), tuple },
    diagnostics: [],
  };
  return Object.freeze(snapshot);
}

export interface SealedNextRunPolicySnapshot {
  readonly snapshot: NextRunPolicySnapshot;
  readonly bytes: Uint8Array;
  readonly digest: string;
}

function plain(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[], path: string): void {
  const expected = [...keys].sort();
  const actual = Object.keys(value).sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    refuse("invalid-document", path, `${path || "snapshot"} has missing or unknown fields`);
  }
}

function decodeBase64(value: unknown, path: string): Uint8Array {
  if (typeof value !== "string" || value.length === 0 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(value)) {
    refuse("invalid-document", path, "exact standard base64 bytes are required");
  }
  const bytes = new Uint8Array(Buffer.from(value, "base64"));
  if (Buffer.from(bytes).toString("base64") !== value) {
    refuse("invalid-document", path, "base64 spelling is not exact");
  }
  return bytes;
}

/** Strictly validates and recomputes a snapshot from every embedded exact byte string. */
function validateSnapshot(value: unknown): NextRunPolicySnapshot {
  if (!plain(value)) refuse("invalid-document", "snapshot", "snapshot must be an object");
  exactKeys(value, ["formatToken", "configRevision", "route", "inputs", "seed", "diagnostics"], "snapshot");
  if (value["formatToken"] !== NEXT_RUN_POLICY_SNAPSHOT_FORMAT_TOKEN
    || typeof value["configRevision"] !== "string" || value["configRevision"].length === 0
    || !Array.isArray(value["diagnostics"]) || value["diagnostics"].length !== 0) {
    refuse("invalid-document", "snapshot", "snapshot token, revision, or diagnostics are invalid");
  }
  const route = value["route"];
  if (!plain(route)) refuse("invalid-document", "snapshot.route", "route must be an object");
  const routeKeys = Object.hasOwn(route, "route") ? ["taskProfile", "route"] : ["taskProfile"];
  exactKeys(route, routeKeys, "snapshot.route");
  if (typeof route["taskProfile"] !== "string" || route["taskProfile"].length === 0
    || (Object.hasOwn(route, "route") && (typeof route["route"] !== "string" || route["route"].length === 0))) {
    refuse("invalid-document", "snapshot.route", "route identity is invalid");
  }
  const inputs = value["inputs"];
  if (!plain(inputs)) refuse("invalid-document", "snapshot.inputs", "inputs must be an object");
  exactKeys(inputs, ["task", "submission", "profile", "loadout"], "snapshot.inputs");
  const part = (name: "task" | "submission" | "profile" | "loadout") => {
    const entry = inputs[name];
    if (!plain(entry)) refuse("invalid-document", `snapshot.inputs.${name}`, "input must be an object");
    const keys = name === "profile"
      ? ["digest", "bytesBase64", "profile", "requirementKeys"]
      : name === "loadout" ? ["digest", "bytesBase64", "hashProfile"] : ["digest", "bytesBase64"];
    exactKeys(entry, keys, `snapshot.inputs.${name}`);
    if (typeof entry["digest"] !== "string") refuse("invalid-document", `snapshot.inputs.${name}.digest`, "digest is required");
    return { entry, bytes: decodeBase64(entry["bytesBase64"], `snapshot.inputs.${name}.bytesBase64`) };
  };
  const task = part("task");
  const submission = part("submission");
  const profile = part("profile");
  const loadout = part("loadout");
  if (typeof profile.entry["profile"] !== "string" || profile.entry["profile"].length === 0
    || !Array.isArray(profile.entry["requirementKeys"])
    || loadout.entry["hashProfile"] !== "learner-public.v1") {
    refuse("invalid-document", "snapshot.inputs", "profile resolution or loadout hash profile is invalid");
  }
  const comparisonClasses = new Set(["exact", "ceiling", "floor", "constraint", "addable"]);
  for (const [index, requirement] of profile.entry["requirementKeys"].entries()) {
    if (!plain(requirement)) refuse("invalid-document", `snapshot.inputs.profile.requirementKeys.${index}`, "requirement key is invalid");
    exactKeys(requirement, ["key", "comparisonClass"], `snapshot.inputs.profile.requirementKeys.${index}`);
    if (typeof requirement["key"] !== "string" || requirement["key"].length === 0
      || typeof requirement["comparisonClass"] !== "string"
      || !comparisonClasses.has(requirement["comparisonClass"])) {
      refuse("invalid-document", `snapshot.inputs.profile.requirementKeys.${index}`, "requirement key is invalid");
    }
  }
  const recomputed = captureNextRunPolicySnapshot({
    configRevisionBefore: value["configRevision"],
    configRevisionAfter: value["configRevision"],
    resolutions: [{
      route: route as unknown as NextRunRoute,
      task: { bytes: task.bytes, digest: task.entry["digest"] as string },
      submission: { bytes: submission.bytes, digest: submission.entry["digest"] as string },
      profile: {
        bytes: profile.bytes,
        digest: profile.entry["digest"] as string,
        profile: profile.entry["profile"] as string,
        requirementKeys: profile.entry["requirementKeys"] as ResolvedTaskProfile["requirementKeys"],
      },
      loadout: { bytes: loadout.bytes, digest: loadout.entry["digest"] as string },
    }],
  });
  if (!bytesEqual(canonicalJsonBytes(recomputed), canonicalJsonBytes(value))) {
    refuse("invalid-document", "snapshot", "seed or resolved fields do not recompute from the exact embedded bytes");
  }
  return recomputed;
}

export function sealNextRunPolicySnapshot(snapshot: NextRunPolicySnapshot): SealedNextRunPolicySnapshot {
  const validated = validateSnapshot(snapshot);
  const bytes = canonicalJsonBytes(validated);
  return { snapshot: validated, bytes, digest: prefixedDigest(bytes) };
}

export function parseExactNextRunPolicySnapshot(bytes: Uint8Array): NextRunPolicySnapshot {
  let value: unknown;
  try { value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
  catch { refuse("invalid-document", "snapshot", "snapshot bytes must be UTF-8 JSON"); }
  const snapshot = validateSnapshot(value);
  if (!bytesEqual(canonicalJsonBytes(snapshot), bytes)) {
    refuse("invalid-document", "snapshot", "snapshot bytes are not the exact canonical encoding");
  }
  return snapshot;
}
