// SPDX-License-Identifier: Apache-2.0

/**
 * Ingestion parser for a prediction Result plus its resolution snapshot. Pure: no network, no
 * clock. The commitment it implements is `fixtures/parsers/prediction-market.parser.json`,
 * whose digest is this parser's identity.
 *
 * Scope note: the pinned semantics document and `fixtures/prediction/README.md` §The seven
 * checks describe seven legacy checks. This parser implements the four that are decidable
 * from `PredictionParseInput` alone — `solution.schema`, `solution.window`, `market.identity`,
 * `market.resolution`. The other three (`solution.envelope`, `integrity.manifest_signature`,
 * `integrity.signedTask_ref`) verify the solver's signed envelope and its task-CID binding,
 * which need envelope/signature/task-ref data this input does not carry. Extending the input
 * to cover them is left to whichever task wires the adapter's execution providers (Task 8+),
 * not decided here.
 */

const decoder = new TextDecoder("utf-8", { fatal: true });
const DECIMAL = /^-?\d+(\.\d+)?$/u;
const FRACTION_DIGITS = 6;

export interface PredictionCheck {
  readonly name:
    | "solution.schema"
    | "solution.window"
    | "market.identity"
    | "market.resolution";
  readonly status: "pass" | "fail" | "indeterminate";
  readonly detail?: string;
}

export interface PredictionScores {
  readonly scoreBasis: "brier-loss.v1";
  readonly solverBrier: string;
  readonly consensusBrier: string;
  readonly brierSpread: string;
}

export interface PredictionOutcome {
  readonly verdict: "pass" | "fail" | "inconclusive";
  readonly integrity: boolean;
  readonly resolved: boolean;
  readonly outcomeYes?: boolean;
  readonly scores?: PredictionScores;
  readonly checks: readonly PredictionCheck[];
}

export interface PredictionParseInput {
  readonly resultBytes: Uint8Array;
  readonly snapshot: unknown;
  readonly market: { readonly marketId: string; readonly conditionId: string };
  readonly window: { readonly startTs: number; readonly endTs: number };
  readonly consensusProbabilityYes: string;
}

/**
 * Squared error as a fixed six-fraction-digit decimal string. Sealed bytes admit only I-JSON
 * integers, so every fractional quantity leaves this parser as a decimal string.
 */
export function brierLoss(probability: string, target: 0 | 1): string {
  const difference = Number(probability) - target;
  return (difference * difference).toFixed(FRACTION_DIGITS);
}

function subtract(left: string, right: string): string {
  return (Number(left) - Number(right)).toFixed(FRACTION_DIGITS);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

interface PredictionResult {
  readonly probabilityYes: string;
  readonly submittedAt: string;
}

function readResult(bytes: Uint8Array): PredictionResult | undefined {
  let text: string;
  try {
    text = decoder.decode(bytes);
  } catch {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!isObject(parsed)) return undefined;
  const probabilityYes = parsed["probabilityYes"];
  const submittedAt = parsed["submittedAt"];
  if (typeof probabilityYes !== "string" || !DECIMAL.test(probabilityYes)) return undefined;
  const probability = Number(probabilityYes);
  if (!Number.isFinite(probability) || probability < 0 || probability > 1) return undefined;
  if (typeof submittedAt !== "string" || !Number.isFinite(Date.parse(submittedAt))) {
    return undefined;
  }
  return { probabilityYes, submittedAt };
}

// Real venue status enum (operator/src/venues/polymarket/client.ts:69-77, Task 2 finding E4 /
// Task 6 finding E12) — five values, no "unavailable" member.
interface Snapshot {
  readonly status: "resolved" | "unresolved" | "invalid" | "cancelled" | "ambiguous";
  readonly outcome?: "YES" | "NO";
  readonly marketId: string;
  readonly conditionId: string;
}

function readSnapshot(value: unknown): Snapshot | undefined {
  if (!isObject(value)) return undefined;
  const status = value["status"];
  if (
    status !== "resolved" &&
    status !== "unresolved" &&
    status !== "invalid" &&
    status !== "cancelled" &&
    status !== "ambiguous"
  ) {
    return undefined;
  }
  const marketId = value["marketId"];
  const conditionId = value["conditionId"];
  if (typeof marketId !== "string" || typeof conditionId !== "string") return undefined;
  const outcome = value["outcome"];
  return {
    status,
    ...(outcome === "YES" || outcome === "NO" ? { outcome } : {}),
    marketId,
    conditionId,
  };
}

/** Lowercase via a code-unit map — never `toLocaleLowerCase`, which consults host ICU data. */
function asciiLower(value: string): string {
  let out = "";
  for (const character of value) {
    const code = character.charCodeAt(0);
    out += code >= 65 && code <= 90 ? String.fromCharCode(code + 32) : character;
  }
  return out;
}

export function parsePredictionResult(
  input: PredictionParseInput,
): PredictionOutcome {
  const result = readResult(input.resultBytes);
  const snapshot = readSnapshot(input.snapshot);

  const schemaCheck: PredictionCheck = result === undefined
    ? {
      name: "solution.schema",
      status: "fail",
      detail: "the Result is not a decodable prediction document in range",
    }
    : { name: "solution.schema", status: "pass" };

  const submittedAt = result === undefined ? Number.NaN : Date.parse(result.submittedAt);
  const inWindow = Number.isFinite(submittedAt)
    && submittedAt >= input.window.startTs
    && submittedAt <= input.window.endTs;
  const windowCheck: PredictionCheck = result === undefined
    ? { name: "solution.window", status: "fail", detail: "no decodable submission time" }
    : inWindow
    ? { name: "solution.window", status: "pass" }
    : {
      name: "solution.window",
      status: "fail",
      detail: "the submission time is outside the declared window",
    };

  const identityMatches = snapshot !== undefined
    && snapshot.marketId === input.market.marketId
    && asciiLower(snapshot.conditionId) === asciiLower(input.market.conditionId);
  const identityCheck: PredictionCheck = identityMatches
    ? { name: "market.identity", status: "pass" }
    : {
      name: "market.identity",
      status: "fail",
      detail: "the resolution snapshot does not identify the declared market",
    };

  const resolutionCheck: PredictionCheck = snapshot === undefined
    ? {
      name: "market.resolution",
      status: "fail",
      detail: "the resolution snapshot is unreadable",
    }
    : snapshot.status === "resolved" && snapshot.outcome !== undefined
    ? { name: "market.resolution", status: "pass" }
    : snapshot.status === "unresolved"
    ? { name: "market.resolution", status: "indeterminate" }
    : {
      name: "market.resolution",
      status: "fail",
      detail: `the venue reported ${snapshot.status}`,
    };

  const checks: readonly PredictionCheck[] = [
    schemaCheck,
    windowCheck,
    identityCheck,
    resolutionCheck,
  ];

  // Integrity is every check EXCEPT resolution: an unresolved market says nothing about the
  // solution, so it must not be laundered into a failing verdict — and a broken integrity
  // check must not be laundered into `inconclusive`.
  const integrity = checks
    .filter((check) => check.name !== "market.resolution")
    .every((check) => check.status === "pass");
  const resolved = resolutionCheck.status === "pass";

  if (!integrity || resolutionCheck.status === "fail") {
    return { verdict: "fail", integrity, resolved, checks };
  }
  if (!resolved) {
    return { verdict: "inconclusive", integrity, resolved, checks };
  }

  const outcomeYes = snapshot!.outcome === "YES";
  const target: 0 | 1 = outcomeYes ? 1 : 0;
  const solverBrier = brierLoss(result!.probabilityYes, target);
  const consensusBrier = brierLoss(input.consensusProbabilityYes, target);
  return {
    verdict: "pass",
    integrity,
    resolved,
    outcomeYes,
    scores: {
      scoreBasis: "brier-loss.v1",
      solverBrier,
      consensusBrier,
      brierSpread: subtract(solverBrier, consensusBrier),
    },
    checks,
  };
}
