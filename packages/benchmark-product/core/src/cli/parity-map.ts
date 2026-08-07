/**
 * The single source of truth for the operations-facade <-> CLI-verb association (BP-13's
 * stopgap, formalized by BP-14). `./parity.test.ts` (the runtime parity proof) and
 * `./parity-matrix.ts` (the machine-readable parity artifact's document builder, consumed by both
 * `./parity-matrix.test.ts` and `../../scripts/generate-parity-matrix.mjs`) both import this
 * module rather than each maintaining their own copy of the same table — a mapping hand-typed in
 * two places is exactly the drift both consumers exist to catch.
 *
 * `OPERATION_TO_VERB`, `OPERATION_TO_ACTION`, and `OPERATION_TO_DESCRIPTION` are themselves
 * hand-maintained — that is unavoidable structural/descriptive metadata connecting one string
 * identifier to another, the same kind of table `./parity.test.ts` already hand-maintained before
 * this module existed. What must NOT be hand-typed is any authority-gating FACT:
 * `./parity-matrix.ts`'s `buildParityMatrixDocument` derives each entry's `authorityGated` by
 * checking `OPERATION_TO_ACTION[name]` against the live `GATED_OPERATIONS` set
 * (`../authority/policy.ts`) at generation time, never a hand-typed boolean here.
 *
 * `OPERATION_TO_ACTION` carries the exact `action` string literal each operation's `operate()` /
 * `operateAsync()` call site passes (`../operations/operate.ts`'s `OperateOptions.action`) — the
 * same string `checkAuthority` receives, and thus the string `GATED_OPERATIONS` membership is
 * actually checked against. Cross-referenced against every operation module's own `action:` call
 * site as of BP-14.
 */

/**
 * Facade exports that are helpers, not operations a caller invokes directly — see
 * `./parity.test.ts`'s own header. Currently just one: `unverifiableAxisCounts`
 * (`../operations/run-results.ts`) is exported so `../report/claim.ts` can reuse the same per-axis
 * tally the results document builds; it is not itself an operation with an
 * `OperationContext`/`OperationResult` shape.
 */
export const EXCLUDED_FACADE_EXPORTS: readonly string[] = ["unverifiableAxisCounts"];

/**
 * The explicit operation -> verb map. A future facade operation with no entry here (or a verb
 * with no operation behind it) is exactly the drift `./parity.test.ts` exists to catch — the fix
 * is always to add the missing counterpart, never to loosen that test.
 */
export const OPERATION_TO_VERB: Readonly<Record<string, string>> = {
  initWorkspace: "init",
  createDraft: "draft create",
  getDraft: "draft show",
  listDrafts: "draft list",
  updateDraft: "draft update",
  inspectDraft: "inspect",
  sampleInit: "sample init",
  importSweBenchRows: "import swebench",
  armAdd: "arm add",
  armUpdate: "arm update",
  armRemove: "arm remove",
  armList: "arm list",
  authorityGrant: "authority grant",
  authorityRevoke: "authority revoke",
  authorityShow: "authority show",
  runPreview: "preview",
  runQuote: "quote",
  runLock: "lock",
  runLaunch: "launch",
  runResume: "resume",
  runCancel: "cancel",
  runStatus: "status",
  runCollect: "collect",
  runResults: "results",
  runReport: "report",
  runVerify: "verify",
};

/** Every operation's own `operate()`/`operateAsync()` `action` literal — see this module's own
 * header. This is what `checkAuthority` (`../authority/policy.ts`) actually receives, and thus
 * the string `GATED_OPERATIONS` membership is checked against for `authorityGated`. */
export const OPERATION_TO_ACTION: Readonly<Record<string, string>> = {
  initWorkspace: "init",
  createDraft: "draft.create",
  getDraft: "draft.get",
  listDrafts: "draft.list",
  updateDraft: "draft.update",
  inspectDraft: "draft.inspect",
  sampleInit: "sample.init",
  importSweBenchRows: "import.swebench",
  armAdd: "arm.add",
  armUpdate: "arm.update",
  armRemove: "arm.remove",
  armList: "arm.list",
  authorityGrant: "authority.grant",
  authorityRevoke: "authority.revoke",
  authorityShow: "authority.show",
  runPreview: "preview",
  runQuote: "quote",
  runLock: "lock",
  runLaunch: "launch",
  runResume: "run.resume",
  runCancel: "cancel",
  runStatus: "run.status",
  runCollect: "run.collect",
  runResults: "run.results",
  runReport: "report",
  runVerify: "run.verify",
};

/** One-line, hand-authored descriptions — prose, not a fact `GATED_OPERATIONS` or any other live
 * set could derive; kept here so the parity matrix's `description` field has one source too. */
export const OPERATION_TO_DESCRIPTION: Readonly<Record<string, string>> = {
  initWorkspace: "Creates a new workspace directory and its founding-sponsor authority policy.",
  createDraft: "Creates a new draft in a workspace, optionally seeded from a spec file.",
  getDraft: "Reads one draft's current document.",
  listDrafts: "Lists every draft in a workspace.",
  updateDraft: "Applies a JSON patch to a draft's spec.",
  inspectDraft: "Resolves and displays a draft's arms, benchmark, and assurance settings.",
  sampleInit: "Attaches the bundled sample benchmark to a draft.",
  importSweBenchRows: "Imports SWE-bench rows as a sealed benchmark attached to a draft.",
  armAdd: "Adds a solver arm (pinning) to a draft.",
  armUpdate: "Updates an existing arm's pinning and/or notes.",
  armRemove: "Removes an arm from a draft.",
  armList: "Lists a draft's arms.",
  authorityGrant: "Grants workspace membership and/or gated-operation grants to a principal (sponsor-only).",
  authorityRevoke: "Revokes a principal's gated-operation grants (sponsor-only).",
  authorityShow: "Reads the workspace's authority policy.",
  runPreview:
    "Runs a disposable rehearsal of the draft's arms on the local venue in a throwaway area; never official evidence, never advances the lifecycle.",
  runQuote: "Prices a compiled run against the local venue's capabilities, without spending.",
  runLock: "Seals the Run record and transitions the draft to locked (authority-gated).",
  runLaunch: "Launches the locked run on the real local venue (authority-gated).",
  runResume: "Resumes an interrupted run, dispatching only outstanding work.",
  runCancel:
    "Requests an authority-gated stop, drains outstanding work, and seals a completely accounted cancelled Matrix.",
  runStatus: "Reads per-cell live status folded from the run journal.",
  runCollect: "Assembles and seals the Matrix once the run's close boundary is reached.",
  runResults: "Reads the sealed Matrix as a results document with venue-honesty disclosures.",
  runReport: "Produces the sealed Report and claim package from the closed run's Matrix (authority-gated).",
  runVerify:
    "Independently re-derives the Matrix (and, once reported, the Report and claim package) from durable workspace state.",
};

/**
 * GUI disposition for every shipped library operation. This is the M3 parity
 * authority: an operation is either backed by one stable GUI action id now or
 * explicitly assigned to the packet that will ship it. Silence is forbidden.
 */
export type GuiCapability =
  | { readonly status: "shipped"; readonly action: string }
  | { readonly status: "deferred"; readonly deferredTo: "BP-32" | "BP-33" };

export const OPERATION_TO_GUI: Readonly<Record<string, GuiCapability>> = {
  initWorkspace: { status: "shipped", action: "workspace.init" },
  createDraft: { status: "shipped", action: "draft.create" },
  getDraft: { status: "shipped", action: "draft.show" },
  listDrafts: { status: "shipped", action: "draft.list" },
  updateDraft: { status: "shipped", action: "draft.update" },
  inspectDraft: { status: "shipped", action: "draft.inspect" },
  sampleInit: { status: "shipped", action: "intake.sample" },
  importSweBenchRows: { status: "shipped", action: "intake.swebench" },
  armAdd: { status: "shipped", action: "arm.add" },
  armUpdate: { status: "shipped", action: "arm.update" },
  armRemove: { status: "shipped", action: "arm.remove" },
  armList: { status: "shipped", action: "arm.list" },
  authorityGrant: { status: "shipped", action: "authority.grant" },
  authorityRevoke: { status: "shipped", action: "authority.revoke" },
  authorityShow: { status: "shipped", action: "authority.show" },
  runPreview: { status: "shipped", action: "run.preview" },
  runQuote: { status: "shipped", action: "run.quote" },
  runLock: { status: "shipped", action: "run.lock" },
  runLaunch: { status: "shipped", action: "run.launch" },
  runResume: { status: "shipped", action: "run.resume" },
  runCancel: { status: "shipped", action: "run.cancel" },
  runStatus: { status: "shipped", action: "run.status" },
  runCollect: { status: "shipped", action: "run.collect" },
  runResults: { status: "deferred", deferredTo: "BP-33" },
  runReport: { status: "deferred", deferredTo: "BP-33" },
  runVerify: { status: "deferred", deferredTo: "BP-33" },
};

/** The facade's own operation exports — every function export not in `EXCLUDED_FACADE_EXPORTS`.
 * Takes the operations-facade module namespace as a parameter so a caller resolving it from
 * `src/` (vitest, `../operations/index.js`) and one resolving it from `dist/`
 * (`generate-parity-matrix.mjs`) share this exact same filter. */
export function facadeOperationNames(operationsModule: Readonly<Record<string, unknown>>): string[] {
  return Object.keys(operationsModule)
    .filter((name) => typeof operationsModule[name] === "function")
    .filter((name) => !EXCLUDED_FACADE_EXPORTS.includes(name));
}
