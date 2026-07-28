import { EFFORT_TIERS, type EffortTier } from "./schemas/common.js";
import { compareCodeUnitStrings } from "./order.js";

/** The five profiles §5.1 comparison classes governing the Task/Submission requirements merge. */
export type ComparisonClass = "exact" | "ceiling" | "floor" | "constraint" | "addable";

/** The merged effective requirement map — a protocol export (program §7.3). */
export type EffectiveRequirements = Record<string, unknown>;

export type MergeRequirementsResult =
  | { ok: true; effective: EffectiveRequirements }
  | { ok: false; category: "invalid-document"; key: string };

// --- structural byte-equality (no I-JSON restriction here: this compares arbitrary requirement
// values, not sealed-document bytes) ---
function canonicalStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalStringify).join(",")}]`;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort(compareCodeUnitStrings);
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalStringify(record[key])}`).join(",")}}`;
}

function byteEqual(a: unknown, b: unknown): boolean {
  return canonicalStringify(a) === canonicalStringify(b);
}

function isEffortTier(value: unknown): value is EffortTier {
  return typeof value === "string" && (EFFORT_TIERS as readonly string[]).includes(value);
}

const EFFORT_RANK: Record<EffortTier, number> = Object.fromEntries(
  EFFORT_TIERS.map((tier, index) => [tier, index]),
) as Record<EffortTier, number>;

// --- the `constraint`-class per-key membership registry (profiles §5.1). Unknown constraint
// keys fall through to the conservative byte-equality default. ---
const MODEL_ID_PROVIDER_PREFIXES: Record<string, string> = {
  "claude-": "anthropic",
  "gpt-": "openai",
  "o1-": "openai",
  "gemini-": "google",
  "llama-": "meta",
  "mistral-": "mistralai",
};

function inferProviderFromModelId(id: string): string | undefined {
  for (const [prefix, provider] of Object.entries(MODEL_ID_PROVIDER_PREFIXES)) {
    if (id.startsWith(prefix)) return provider;
  }
  return undefined;
}

function modelConstraintAdmits(taskConstraint: unknown, submissionValue: unknown): boolean {
  if (typeof taskConstraint !== "object" || taskConstraint === null) return false;
  if (typeof submissionValue !== "object" || submissionValue === null) return false;
  const constraint = taskConstraint as { provider?: unknown; id?: unknown };
  const value = submissionValue as { provider?: unknown; id?: unknown };
  if (typeof constraint.provider === "string") {
    if (typeof value.provider === "string") return value.provider === constraint.provider;
    if (typeof value.id === "string") return inferProviderFromModelId(value.id) === constraint.provider;
    return false;
  }
  if (typeof constraint.id === "string") return value.id === constraint.id;
  return false;
}

const CONSTRAINT_MEMBERSHIP: Record<string, (task: unknown, submission: unknown) => boolean> = {
  model: modelConstraintAdmits,
};

/**
 * The tighten-only merge of profiles §5.1 (program §7.3, pinned signature). Evaluated by a
 * backend at `submit` over both byte documents; `keyClasses` = the fixed core-key classes plus
 * the resolved profile document's `requirementKeys` classes, assembled by the caller.
 *
 * `unsupported-requirement` (a pinning key absent from a backend's capability inventory) is
 * never produced here — that is the product of the backend capability check, not this pure
 * merge (program §7.3).
 */
export function mergeRequirements(
  taskRequirements: Record<string, unknown> | undefined,
  submissionRequirements: Record<string, unknown> | undefined,
  keyClasses: Record<string, ComparisonClass>,
): MergeRequirementsResult {
  const task = taskRequirements ?? {};
  const submission = submissionRequirements ?? {};
  const keys = new Set([...Object.keys(task), ...Object.keys(submission)]);
  const effective: EffectiveRequirements = {};

  for (const key of keys) {
    const inTask = Object.hasOwn(task, key);
    const inSubmission = Object.hasOwn(submission, key);
    const taskValue = task[key];
    const submissionValue = submission[key];

    if (inTask && !inSubmission) {
      // The Task's mandatory value stands; the Submission made no counter-assertion.
      effective[key] = taskValue;
      continue;
    }

    if (!inTask && inSubmission) {
      // No Task constraint exists to violate — the Submission sets it freely (this is exactly
      // the `addable` relation, and is also how a pinning key outside a backend's declared
      // inventory merges here; that rejection belongs to the backend capability check, §7.3).
      effective[key] = submissionValue;
      continue;
    }

    // Both sides declare a value: the key's comparison class decides the merge.
    const keyClass = keyClasses[key];
    switch (keyClass) {
      case "exact": {
        if (byteEqual(taskValue, submissionValue)) { effective[key] = submissionValue; continue; }
        return { ok: false, category: "invalid-document", key };
      }
      case "ceiling": {
        if (
          typeof taskValue === "number" && typeof submissionValue === "number"
          && submissionValue <= taskValue
        ) { effective[key] = submissionValue; continue; }
        return { ok: false, category: "invalid-document", key };
      }
      case "floor": {
        if (isEffortTier(taskValue) && isEffortTier(submissionValue)) {
          if (EFFORT_RANK[submissionValue] >= EFFORT_RANK[taskValue]) {
            effective[key] = submissionValue;
            continue;
          }
          return { ok: false, category: "invalid-document", key };
        }
        if (
          typeof taskValue === "number" && typeof submissionValue === "number"
          && submissionValue >= taskValue
        ) { effective[key] = submissionValue; continue; }
        return { ok: false, category: "invalid-document", key };
      }
      case "constraint": {
        const membershipTest = CONSTRAINT_MEMBERSHIP[key];
        const admitted = membershipTest !== undefined
          ? membershipTest(taskValue, submissionValue)
          : byteEqual(taskValue, submissionValue); // unknown constraint keys: conservative default
        if (admitted) { effective[key] = submissionValue; continue; }
        return { ok: false, category: "invalid-document", key };
      }
      case "addable":
      default: {
        // `addable`'s relation only applies when the key is absent from the Task (handled
        // above); a key present in both under `addable`, an unknown class, or no declared
        // class at all is the conservative default: byte-equal or invalid-document.
        if (byteEqual(taskValue, submissionValue)) { effective[key] = submissionValue; continue; }
        return { ok: false, category: "invalid-document", key };
      }
    }
  }

  return { ok: true, effective };
}
