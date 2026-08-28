import {
  cellKey,
  compareCodeUnitStrings,
  sealMatrix,
  type MatrixRecord,
} from "@jinn-network/benchmarking-records";

const SHA256 = /^[a-f0-9]{64}$/;
const SHA256_URI = /^sha256:[a-f0-9]{64}$/;
// §3.1 rule 1: one identifier dialect, not two. Shared shape with `candidateClass`.
const STRATUM_NAME = /^[A-Za-z][A-Za-z0-9._-]{0,63}$/;

export type BinaryInstrumentDecision = "ACCEPT" | "REJECT";
export type BinaryInstrumentTruthLabel = "CORRECT" | "WRONG";
export type BinaryInstrumentStratum = string;

/** Evaluator-only item facts. The execution profile must not expose these to the solver. */
export interface BinaryInstrumentItemContext {
  readonly analysisContextSha256: string;
  readonly truthLabel: BinaryInstrumentTruthLabel;
  readonly candidateClass: string;
  readonly stratum: BinaryInstrumentStratum;
  readonly labelResolutionSha256: string;
}

export interface BinaryInstrumentExpectedContext {
  readonly taskDigest: string;
  readonly context: BinaryInstrumentItemContext;
}

export interface BinaryInstrumentExpectedInstrument {
  readonly armId: string;
  readonly instrumentSha256: string;
}

/**
 * The narrow parsed-cell boundary consumed by the reducer. F5 deliberately owns no Result
 * Evaluation parser: the later profile adapter must supply one exact input for the Matrix cell's
 * sole valid verdict and bind it to the expected evaluator-only context and arm instrument.
 */
export interface BinaryInstrumentParsedCellInput {
  readonly cellKey: string;
  readonly verdictDigest: string;
  readonly verdict: "pass" | "fail" | "inconclusive";
  readonly judgeDecision: BinaryInstrumentDecision | null;
  readonly parseValid: boolean;
  readonly instrumentSha256: string;
  readonly context: BinaryInstrumentItemContext;
}

export interface BinaryInstrumentReductionInput {
  readonly subjectSha256: string;
  readonly matrix: MatrixRecord;
  readonly k: number;
  readonly contexts: readonly BinaryInstrumentExpectedContext[];
  readonly instruments: readonly BinaryInstrumentExpectedInstrument[];
  readonly cells: readonly BinaryInstrumentParsedCellInput[];
  /** The sealed `parameters.strata` declared vocabulary (spec §3.2's membership source). */
  readonly strata: readonly string[];
  /** Defaults to the legacy substantive-REJECT policy for byte-compatible callers. */
  readonly parserInvalidPolicy?: "reject" | "abstain";
}

export interface BinaryInstrumentReducedCall {
  readonly cellKey: string;
  readonly taskDigest: string;
  readonly armId: string;
  readonly replicate: number;
  readonly verdictDigest: string;
  readonly verdict: "pass" | "fail" | "inconclusive";
  readonly judgeDecision: BinaryInstrumentDecision | null;
  readonly parseValid: boolean;
  readonly instrumentSha256: string;
  readonly context: BinaryInstrumentItemContext;
}

export interface BinaryInstrumentItemDecision {
  readonly taskDigest: string;
  readonly armId: string;
  readonly instrumentSha256: string;
  readonly context: BinaryInstrumentItemContext;
  readonly cellKeys: readonly string[];
  readonly calls: readonly BinaryInstrumentReducedCall[];
  readonly accepted: number;
  readonly rejected: number;
  readonly decision: BinaryInstrumentDecision;
  readonly unstable: boolean;
}

export type BinaryInstrumentExclusionReason =
  | "cell-not-judged"
  | "conflicted-evaluations"
  | "inconclusive-evaluation"
  | "missing-evaluation"
  | "no-valid-majority";

export interface BinaryInstrumentExclusionDetail {
  readonly reason: BinaryInstrumentExclusionReason;
  readonly cellKeys: readonly string[];
}

export interface BinaryInstrumentExcludedItem {
  readonly taskDigest: string;
  readonly armId: string;
  readonly instrumentSha256: string;
  readonly context: BinaryInstrumentItemContext;
  readonly cellKeys: readonly string[];
  readonly reasons: readonly BinaryInstrumentExclusionDetail[];
}

export interface BinaryInstrumentReduction {
  readonly subjectSha256: string;
  readonly k: number;
  readonly items: readonly BinaryInstrumentItemDecision[];
  /** Every decisive parsed call, including calls in a group excluded because a peer is absent. */
  readonly evaluatedCalls: readonly BinaryInstrumentReducedCall[];
  readonly excluded: readonly BinaryInstrumentExcludedItem[];
  readonly conflicted: { readonly count: number; readonly cellKeys: readonly string[] };
}

export type BinaryInstrumentReductionErrorCode =
  | "context-drift"
  | "duplicate-cell-input"
  | "duplicate-coordinate"
  | "incomplete-coordinate-set"
  | "instrument-drift"
  | "invalid-k"
  | "invalid-subject"
  | "subject-digest-mismatch"
  | "unknown-cell-input"
  | "unsupported-vocabulary"
  | "verdict-digest-mismatch";

export class BinaryInstrumentReductionError extends Error {
  readonly name = "BinaryInstrumentReductionError";

  constructor(
    readonly code: BinaryInstrumentReductionErrorCode,
    detail: string,
  ) {
    super(`${code}: ${detail}`);
  }
}

function fail(code: BinaryInstrumentReductionErrorCode, detail: string): never {
  throw new BinaryInstrumentReductionError(code, detail);
}

function requireSha256(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !SHA256.test(value)) {
    fail("unsupported-vocabulary", `${label} must be 64 lowercase hexadecimal characters`);
  }
}

function requireContext(
  context: BinaryInstrumentItemContext,
  label: string,
  strata: readonly string[],
): void {
  if (typeof context !== "object" || context === null) {
    fail("unsupported-vocabulary", `${label} must be an item context`);
  }
  requireSha256(context.analysisContextSha256, `${label}.analysisContextSha256`);
  requireSha256(context.labelResolutionSha256, `${label}.labelResolutionSha256`);
  if (context.truthLabel !== "CORRECT" && context.truthLabel !== "WRONG") {
    fail("unsupported-vocabulary", `${label}.truthLabel must be CORRECT or WRONG`);
  }
  // §3.2: membership in the sealed `parameters.strata` is enforced exactly once, here.
  if (typeof context.stratum !== "string" || !strata.includes(context.stratum)) {
    fail("unsupported-vocabulary", `${label}.stratum is not in the sealed stratum vocabulary`);
  }
  if (typeof context.candidateClass !== "string" || context.candidateClass.trim().length === 0) {
    fail("unsupported-vocabulary", `${label}.candidateClass must be non-empty text`);
  }
}

function sameContext(left: BinaryInstrumentItemContext, right: BinaryInstrumentItemContext): boolean {
  return left.analysisContextSha256 === right.analysisContextSha256
    && left.truthLabel === right.truthLabel
    && left.candidateClass === right.candidateClass
    && left.stratum === right.stratum
    && left.labelResolutionSha256 === right.labelResolutionSha256;
}

function groupKey(taskDigest: string, armId: string): string {
  return `${taskDigest}\u001f${armId}`;
}

function compareGroup(
  left: Pick<BinaryInstrumentItemDecision, "taskDigest" | "armId">,
  right: Pick<BinaryInstrumentItemDecision, "taskDigest" | "armId">,
): number {
  const byTask = compareCodeUnitStrings(left.taskDigest, right.taskDigest);
  return byTask === 0 ? compareCodeUnitStrings(left.armId, right.armId) : byTask;
}

function cloneContext(context: BinaryInstrumentItemContext): BinaryInstrumentItemContext {
  return { ...context };
}

function validateExactSubject(input: BinaryInstrumentReductionInput): void {
  requireSha256(input.subjectSha256, "subjectSha256");
  let exact: string;
  try {
    exact = sealMatrix(input.matrix).digest.slice("sha256:".length);
  } catch (cause) {
    fail("invalid-subject", cause instanceof Error ? cause.message : String(cause));
  }
  if (exact !== input.subjectSha256) {
    fail("subject-digest-mismatch", `declared ${input.subjectSha256}, exact Matrix digest ${exact}`);
  }
}

function validateParsedCell(
  input: BinaryInstrumentParsedCellInput,
  label: string,
  strata: readonly string[],
): void {
  if (typeof input !== "object" || input === null) {
    fail("unsupported-vocabulary", `${label} must be a parsed cell input`);
  }
  if (typeof input.cellKey !== "string" || input.cellKey.length === 0) {
    fail("unsupported-vocabulary", `${label}.cellKey must be non-empty text`);
  }
  if (typeof input.verdictDigest !== "string" || !SHA256_URI.test(input.verdictDigest)) {
    fail("unsupported-vocabulary", `${label}.verdictDigest must be sha256:<64 lowercase hex>`);
  }
  if (input.verdict !== "pass" && input.verdict !== "fail" && input.verdict !== "inconclusive") {
    fail("unsupported-vocabulary", `${label}.verdict is unsupported`);
  }
  if (input.verdict === "inconclusive") {
    if (input.judgeDecision !== null) {
      fail("unsupported-vocabulary", `${label}.judgeDecision must be null for an inconclusive evaluation`);
    }
  } else if (input.judgeDecision !== "ACCEPT" && input.judgeDecision !== "REJECT") {
    fail("unsupported-vocabulary", `${label}.judgeDecision must be ACCEPT or REJECT for a decisive evaluation`);
  }
  if (typeof input.parseValid !== "boolean") {
    fail("unsupported-vocabulary", `${label}.parseValid must be boolean`);
  }
  requireSha256(input.instrumentSha256, `${label}.instrumentSha256`);
  requireContext(input.context, `${label}.context`, strata);
}

/**
 * Reduces one exact Matrix subject's accountable scientific cells to item-arm majorities. It does
 * not parse Result Evaluation bytes, calculate qualification metrics, or interpret infrastructure
 * dispatch counts. A replacement dispatch therefore remains part of the same scientific cell.
 */
export function reduceBinaryInstrumentReplicates(
  input: BinaryInstrumentReductionInput,
): BinaryInstrumentReduction {
  const parserInvalidPolicy = input.parserInvalidPolicy ?? "reject";
  if (parserInvalidPolicy !== "reject" && parserInvalidPolicy !== "abstain") {
    fail("unsupported-vocabulary", "parserInvalidPolicy must be reject or abstain");
  }
  if (!Number.isSafeInteger(input.k) || input.k < 1 || input.k % 2 === 0) {
    fail("invalid-k", `k must be an odd positive safe integer; got ${String(input.k)}`);
  }
  if (input.matrix.cells.length === 0) fail("invalid-subject", "Matrix must contain at least one cell");
  // Deliberately non-empty + grammar-conforming only, not sorted-and-unique: `input.strata` is
  // the already-sealed `parameters.strata` (spec §3.1 rule 3), and `validateBinaryInstrumentParameters`
  // (binary-instrument-method.ts) is the one enforcement point for sorted-and-unique on that value
  // per spec §0.5. Re-checking it here would be a second enforcement point for a property the
  // sealed input already carries.
  if (
    !Array.isArray(input.strata)
    || input.strata.length === 0
    || input.strata.some((value) => typeof value !== "string" || !STRATUM_NAME.test(value))
  ) {
    fail("unsupported-vocabulary", "strata must be the sealed non-empty stratum vocabulary");
  }

  // Check coordinates before schema sealing so the reducer owns a stable duplicate-coordinate
  // failure even when a caller bypasses the records parser at the TypeScript boundary.
  const coordinateKeys = new Set<string>();
  const matrixCellKeys = new Set<string>();
  for (const matrixCell of input.matrix.cells) {
    const coordinate = groupKey(groupKey(matrixCell.taskDigest, matrixCell.armId), String(matrixCell.replicate));
    if (coordinateKeys.has(coordinate) || matrixCellKeys.has(matrixCell.cellKey)) {
      fail("duplicate-coordinate", `Matrix repeats ${matrixCell.taskDigest}/${matrixCell.armId}/${matrixCell.replicate}`);
    }
    coordinateKeys.add(coordinate);
    matrixCellKeys.add(matrixCell.cellKey);
  }
  validateExactSubject(input);

  const taskDigests = [...new Set(input.matrix.cells.map((value) => value.taskDigest))]
    .sort(compareCodeUnitStrings);
  const armIds = [...new Set(input.matrix.cells.map((value) => value.armId))]
    .sort(compareCodeUnitStrings);

  const expectedCellKeys = new Set<string>();
  for (const taskDigest of taskDigests) {
    for (const armId of armIds) {
      for (let replicate = 1; replicate <= input.k; replicate += 1) {
        expectedCellKeys.add(cellKey(taskDigest, armId, replicate));
      }
    }
  }
  if (
    expectedCellKeys.size !== input.matrix.cells.length
    || [...expectedCellKeys].some((expected) => !matrixCellKeys.has(expected))
    || [...matrixCellKeys].some((actual) => !expectedCellKeys.has(actual))
  ) {
    fail(
      "incomplete-coordinate-set",
      `Matrix is not the exact task x arm x 1..${input.k} cell set`,
    );
  }

  const contexts = new Map<string, BinaryInstrumentItemContext>();
  for (const [index, entry] of input.contexts.entries()) {
    requireSha256(entry.taskDigest, `contexts[${index}].taskDigest`);
    requireContext(entry.context, `contexts[${index}].context`, input.strata);
    if (contexts.has(entry.taskDigest)) fail("context-drift", `duplicate context for Task ${entry.taskDigest}`);
    contexts.set(entry.taskDigest, cloneContext(entry.context));
  }
  if (
    contexts.size !== taskDigests.length
    || taskDigests.some((digest) => !contexts.has(digest))
    || [...contexts.keys()].some((digest) => !taskDigests.includes(digest))
  ) {
    fail("context-drift", "contexts must name every and only Matrix Task exactly once");
  }

  const instruments = new Map<string, string>();
  for (const [index, entry] of input.instruments.entries()) {
    if (typeof entry.armId !== "string" || entry.armId.length === 0) {
      fail("unsupported-vocabulary", `instruments[${index}].armId must be non-empty text`);
    }
    requireSha256(entry.instrumentSha256, `instruments[${index}].instrumentSha256`);
    if (instruments.has(entry.armId)) fail("instrument-drift", `duplicate instrument for arm ${entry.armId}`);
    instruments.set(entry.armId, entry.instrumentSha256);
  }
  if (
    instruments.size !== armIds.length
    || armIds.some((armId) => !instruments.has(armId))
    || [...instruments.keys()].some((armId) => !armIds.includes(armId))
  ) {
    fail("instrument-drift", "instruments must name every and only Matrix arm exactly once");
  }

  const parsedByCell = new Map<string, BinaryInstrumentParsedCellInput>();
  for (const [index, parsed] of input.cells.entries()) {
    validateParsedCell(parsed, `cells[${index}]`, input.strata);
    if (!matrixCellKeys.has(parsed.cellKey)) {
      fail("unknown-cell-input", `parsed input names non-Matrix cell ${parsed.cellKey}`);
    }
    if (parsedByCell.has(parsed.cellKey)) {
      fail("duplicate-cell-input", `multiple parsed inputs name ${parsed.cellKey}`);
    }
    parsedByCell.set(parsed.cellKey, parsed);
  }

  const cellsByGroup = new Map<string, typeof input.matrix.cells[number][]>();
  for (const matrixCell of input.matrix.cells) {
    const key = groupKey(matrixCell.taskDigest, matrixCell.armId);
    const group = cellsByGroup.get(key) ?? [];
    group.push(matrixCell);
    cellsByGroup.set(key, group);
  }

  const items: BinaryInstrumentItemDecision[] = [];
  const evaluatedCalls: BinaryInstrumentReducedCall[] = [];
  const excluded: BinaryInstrumentExcludedItem[] = [];
  const conflictedCellKeys: string[] = [];

  for (const taskDigest of taskDigests) {
    const expectedContext = contexts.get(taskDigest)!;
    for (const armId of armIds) {
      const expectedInstrument = instruments.get(armId)!;
      const group = [...(cellsByGroup.get(groupKey(taskDigest, armId)) ?? [])]
        .sort((left, right) => left.replicate - right.replicate);
      const reasonCells = new Map<BinaryInstrumentExclusionReason, string[]>();
      const calls: BinaryInstrumentReducedCall[] = [];
      const addReason = (reason: BinaryInstrumentExclusionReason, key: string): void => {
        const keys = reasonCells.get(reason) ?? [];
        keys.push(key);
        reasonCells.set(reason, keys);
      };

      for (const matrixCell of group) {
        const parsed = parsedByCell.get(matrixCell.cellKey);
        if (matrixCell.outcome !== "judged") {
          if (parsed !== undefined) {
            fail("unknown-cell-input", `non-judged cell ${matrixCell.cellKey} carries a parsed evaluation`);
          }
          addReason("cell-not-judged", matrixCell.cellKey);
          continue;
        }
        if (matrixCell.validVerdicts.length !== 1) {
          if (parsed !== undefined) {
            fail("unknown-cell-input", `cell ${matrixCell.cellKey} without a sole valid verdict carries a parsed evaluation`);
          }
          if (matrixCell.validVerdicts.length > 1) {
            addReason("conflicted-evaluations", matrixCell.cellKey);
            conflictedCellKeys.push(matrixCell.cellKey);
          } else {
            addReason("missing-evaluation", matrixCell.cellKey);
          }
          continue;
        }
        if (parsed === undefined) {
          addReason("missing-evaluation", matrixCell.cellKey);
          continue;
        }
        if (parsed.verdictDigest !== matrixCell.validVerdicts[0]) {
          fail(
            "verdict-digest-mismatch",
            `${matrixCell.cellKey} parsed ${parsed.verdictDigest}, Matrix names ${matrixCell.validVerdicts[0]}`,
          );
        }
        if (parsed.instrumentSha256 !== expectedInstrument) {
          fail("instrument-drift", `${matrixCell.cellKey} does not carry arm ${armId}'s expected instrument`);
        }
        if (!sameContext(parsed.context, expectedContext)) {
          fail("context-drift", `${matrixCell.cellKey} does not carry Task ${taskDigest}'s expected context`);
        }
        if (parsed.verdict === "inconclusive") {
          if (parserInvalidPolicy !== "abstain" || parsed.parseValid) {
            addReason("inconclusive-evaluation", matrixCell.cellKey);
            continue;
          }
        }
        const call: BinaryInstrumentReducedCall = {
          cellKey: matrixCell.cellKey,
          taskDigest,
          armId,
          replicate: matrixCell.replicate,
          verdictDigest: parsed.verdictDigest,
          verdict: parsed.verdict,
          judgeDecision: parsed.judgeDecision,
          parseValid: parsed.parseValid,
          instrumentSha256: expectedInstrument,
          context: cloneContext(expectedContext),
        };
        calls.push(call);
        evaluatedCalls.push(call);
      }

      const allCellKeys = group.map((value) => value.cellKey).sort(compareCodeUnitStrings);
      if (reasonCells.size > 0) {
        excluded.push({
          taskDigest,
          armId,
          instrumentSha256: expectedInstrument,
          context: cloneContext(expectedContext),
          cellKeys: allCellKeys,
          reasons: [...reasonCells.entries()]
            .map(([reason, keys]) => ({ reason, cellKeys: keys.sort(compareCodeUnitStrings) }))
            .sort((left, right) => compareCodeUnitStrings(left.reason, right.reason)),
        });
        continue;
      }

      if (calls.length !== input.k) {
        // Coordinate and reason handling above make this unreachable unless a future input state is
        // added without defining its exclusion semantics. Fail closed rather than weakening k.
        fail("incomplete-coordinate-set", `${taskDigest}/${armId} has ${calls.length} decisive calls, expected ${input.k}`);
      }
      calls.sort((left, right) => left.replicate - right.replicate);
      const accepted = calls.filter((call) => call.judgeDecision === "ACCEPT").length;
      const rejected = calls.filter((call) => call.judgeDecision === "REJECT").length;
      const requiredMajority = Math.floor(input.k / 2) + 1;
      if (
        parserInvalidPolicy === "abstain"
        && accepted < requiredMajority
        && rejected < requiredMajority
      ) {
        excluded.push({
          taskDigest,
          armId,
          instrumentSha256: expectedInstrument,
          context: cloneContext(expectedContext),
          cellKeys: allCellKeys,
          reasons: [{ reason: "no-valid-majority", cellKeys: allCellKeys }],
        });
        continue;
      }
      items.push({
        taskDigest,
        armId,
        instrumentSha256: expectedInstrument,
        context: cloneContext(expectedContext),
        cellKeys: allCellKeys,
        calls,
        accepted,
        rejected,
        decision: accepted >= requiredMajority ? "ACCEPT" : "REJECT",
        unstable: accepted !== 0 && rejected !== 0,
      });
    }
  }

  items.sort(compareGroup);
  excluded.sort(compareGroup);
  evaluatedCalls.sort((left, right) => compareCodeUnitStrings(left.cellKey, right.cellKey));
  conflictedCellKeys.sort(compareCodeUnitStrings);
  return {
    subjectSha256: input.subjectSha256,
    k: input.k,
    items,
    evaluatedCalls,
    excluded,
    conflicted: { count: conflictedCellKeys.length, cellKeys: conflictedCellKeys },
  };
}
