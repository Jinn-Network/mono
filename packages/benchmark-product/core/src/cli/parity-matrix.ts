/**
 * The machine-readable capability-parity matrix's document builder (BP-14, deliverable 1).
 * `../../scripts/generate-parity-matrix.mjs` (run against the BUILT `dist/`) and
 * `./parity-matrix.test.ts` (run against `src/` directly, via vitest, no build required) both
 * call `buildParityMatrixDocument` with their own resolution of the same live facts — the
 * operations facade's own exports, the CLI's own `CLI_VERB_NAMES`, and the authority module's own
 * `GATED_OPERATIONS` — so the document-SHAPING logic here can never itself drift between "what
 * ships" and "what the test checks before a build has even run". `./parity-map.ts` supplies the
 * hand-maintained operation<->verb / operation<->action / operation<->description tables both
 * callers also share.
 *
 * `authorityGated` is the one fact this module refuses to accept as an input: it is always
 * DERIVED, per entry, by checking that operation's `OPERATION_TO_ACTION` action string against the
 * caller-supplied `gatedOperations` set — never a boolean a caller hands in directly. That is what
 * keeps the parity matrix's authority claims honest against `../authority/policy.ts`'s
 * `GATED_OPERATIONS`, wherever it is resolved from.
 */

export interface ParityMatrixEntry {
  readonly operation: string;
  readonly cliVerb: string;
  readonly authorityGated: boolean;
  readonly description: string;
  readonly gui:
    | { readonly status: "shipped"; readonly action: string }
    | { readonly status: "deferred"; readonly deferredTo: "BP-32" | "BP-33" };
}

export interface ParityMatrixExclusion {
  readonly name: string;
  readonly reason: string;
}

export interface ParityMatrixDocument {
  readonly schemaVersion: 1;
  readonly generatedFrom: string;
  readonly entries: readonly ParityMatrixEntry[];
  readonly exclusions: readonly ParityMatrixExclusion[];
}

export interface BuildParityMatrixInput {
  readonly packageName: string;
  readonly packageVersion: string;
  /** The operations-facade module namespace (`import * as operations from "../operations/index.js"`,
   * or the `dist/`-resolved equivalent). */
  readonly operationsModule: Readonly<Record<string, unknown>>;
  readonly cliVerbNames: readonly string[];
  /** `../authority/policy.ts`'s `GATED_OPERATIONS`, resolved by the caller — never hand-typed here. */
  readonly gatedOperations: readonly string[];
  readonly operationToVerb: Readonly<Record<string, string>>;
  readonly operationToAction: Readonly<Record<string, string>>;
  readonly operationToDescription: Readonly<Record<string, string>>;
  readonly operationToGui: Readonly<Record<string, ParityMatrixEntry["gui"]>>;
  readonly excludedFacadeExports: readonly string[];
  readonly standaloneCliVerbs: Readonly<Record<string, string>>;
  readonly facadeOperationNames: (operationsModule: Readonly<Record<string, unknown>>) => readonly string[];
}

/**
 * Builds the parity-matrix document. Throws (loud, not a silently-wrong document) if any facade
 * operation is missing a `parity-map.ts` counterpart, or if `OPERATION_TO_VERB` names a verb the
 * CLI's own `CLI_VERB_NAMES` does not carry — the same drift `./parity.test.ts` independently
 * catches, checked again here so a generator run never emits a document parity.test.ts would
 * reject.
 */
export function buildParityMatrixDocument(input: BuildParityMatrixInput): ParityMatrixDocument {
  const {
    packageName,
    packageVersion,
    operationsModule,
    cliVerbNames,
    gatedOperations,
    operationToVerb,
    operationToAction,
    operationToDescription,
    operationToGui,
    excludedFacadeExports,
    standaloneCliVerbs,
    facadeOperationNames,
  } = input;

  // Sorted explicitly rather than trusting `facadeOperationNames`' own iteration order: a real
  // ES module namespace object (`dist/`, Node's native ESM loader) enumerates its string keys
  // alphabetically per spec, but vitest/esbuild's transformed module namespace does not — the two
  // callers of this function would otherwise emit differently-ordered (though equally correct)
  // documents, which is exactly the false-positive drift this module exists to prevent.
  const operationNames = [...facadeOperationNames(operationsModule)].sort();
  const gatedSet = new Set(gatedOperations);

  const entries: ParityMatrixEntry[] = operationNames.map((name) => {
    const cliVerb = operationToVerb[name];
    if (cliVerb === undefined) {
      throw new Error(`generate-parity-matrix: facade export "${name}" has no OPERATION_TO_VERB entry in parity-map.ts`);
    }
    if (!cliVerbNames.includes(cliVerb)) {
      throw new Error(`generate-parity-matrix: verb "${cliVerb}" (for "${name}") is not registered in main.ts's VERBS map`);
    }
    const action = operationToAction[name];
    if (action === undefined) {
      throw new Error(`generate-parity-matrix: facade export "${name}" has no OPERATION_TO_ACTION entry in parity-map.ts`);
    }
    const description = operationToDescription[name];
    if (description === undefined) {
      throw new Error(`generate-parity-matrix: facade export "${name}" has no OPERATION_TO_DESCRIPTION entry in parity-map.ts`);
    }
    const gui = operationToGui[name];
    if (gui === undefined) {
      throw new Error(`generate-parity-matrix: facade export "${name}" has no OPERATION_TO_GUI entry in parity-map.ts`);
    }
    return { operation: name, cliVerb, authorityGated: gatedSet.has(action), description, gui };
  });

  // GATED_OPERATIONS entries with no operation module behind them yet (e.g. "cancel"/"publish" as
  // of BP-14, per authority/policy.ts's own comment) — surfaced here, derived live, rather than
  // silently absent from the matrix.
  const actionsInUse = new Set(Object.values(operationToAction));
  const gatedButUnimplemented = gatedOperations.filter((operation) => !actionsInUse.has(operation));

  const exclusions: ParityMatrixExclusion[] = [
    ...excludedFacadeExports.map((name) => ({
      name,
      reason: "facade export is a helper re-export, not an operation invoked directly (see src/cli/parity-map.ts)",
    })),
    ...Object.entries(standaloneCliVerbs).map(([name, reason]) => ({ name, reason })),
    ...gatedButUnimplemented.map((operation) => ({
      name: operation,
      reason:
        `"${operation}" is in authority/policy.ts's GATED_OPERATIONS but no shipped operation uses it as an `
        + "action name yet — reserved for a later packet",
    })),
  ];

  return {
    schemaVersion: 1,
    generatedFrom: `${packageName}@${packageVersion}`,
    entries,
    exclusions,
  };
}

/** Renders a `ParityMatrixDocument` to the exact bytes the committed `parity-matrix.v1.json`
 * carries — pretty-printed, trailing newline. Both the generator script and its test render
 * through this one function so "what gets written" and "what gets compared" can never diverge. */
export function renderParityMatrixDocument(document: ParityMatrixDocument): string {
  return `${JSON.stringify(document, null, 2)}\n`;
}
