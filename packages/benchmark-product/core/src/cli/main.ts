/**
 * The CLI's dispatch table (spec §5.2) — the complete agent surface through
 * BP-51. Twenty-seven parity operations over the operations facade (`init`,
 * `draft create`, `draft update`, `draft show`, `draft list`, `inspect`,
 * `sample init`, `import swebench`, `arm add`, `arm update`, `arm remove`,
 * `arm list`, `authority grant`, `authority revoke`, `authority show`,
 * `quote`, `lock`, `launch`, `resume`, `status`, `collect`, `results`,
 * `cancel`, `report`, `verify`, `publish`), plus the path-oriented standalone
 * `bundle verify` and Demo-1 preregistration-verifier exclusions, plus `help`.
 * Every verb takes `--json` for a machine-readable envelope; every failure is a
 * typed error envelope with a distinct exit code (§4.3). `runCli` never throws and never touches
 * `process` — `bin.ts` is the only file in this package that does.
 *
 * `runCli` is `async` because `sample.init` (spec: the bundled sample
 * benchmark) runs through `operateAsync`, not `operate` — building and
 * sealing the sample is itself async. A verb handler may return a
 * `CliResult` directly or a `Promise<CliResult>`; the dispatch always
 * `await`s it, so a synchronous handler pays nothing for the `await`.
 *
 * `launch` and `resume` (BP-13, the run path's two long-running verbs) also
 * pass `context.progress` through to the operations facade as `onProgress`,
 * but ONLY in human mode — `--json` mode's stdout stays the single
 * machine-parseable envelope this file always rendered, nothing streams.
 * `bin.ts` wires `progress` to stderr, so even in human mode stdout carries
 * only the final rendered result.
 *
 * `CLI_VERB_NAMES` is the dispatch inventory. The generated parity artifact
 * checks the 27 workspace operations against the facade and records the two
 * read-only standalone verifiers separately.
 */

import { PRODUCT_BRANDING } from "../branding.js";
import { refuse, toErrorEnvelope, type ProductErrorCode, type ProductErrorEnvelope } from "../errors.js";
import {
  armAdd,
  armList,
  armRemove,
  armUpdate,
  authorityGrant,
  authorityRevoke,
  authorityShow,
  createDraft,
  getDraft,
  importSweBenchRows,
  initWorkspace,
  inspectDraft,
  listDrafts,
  runCollect,
  runCancel,
  runLaunch,
  runLock,
  publicationAccounting,
  publicationConfigure,
  publicationRegister,
  publicationReport,
  publicationStatus,
  runPreview,
  runPublish,
  runQuote,
  runReport,
  runResults,
  runResume,
  runStatus,
  runVerify,
  sampleInit,
  selectInspectEvaluation,
  selectHarborRuntime,
  selectTerminalBench2Runtime,
  migrateTerminalBenchLegacyTask,
  updateDraft,
  type ArmWarning,
  type OperationContext,
  type OperationResult,
  type QuotePresentation,
  type RunLaunchDeps,
  type SelectInspectEvaluationInput,
  type SelectHarborRuntimeInput,
  type SelectTerminalBench2RuntimeInput,
  type MigrateTerminalBenchLegacyTaskInput,
} from "../operations/index.js";
import { verifyPublicBundle } from "../bundle/verify.js";
import { verifyDemo1PreregistrationPreDispatch } from "../method/demo1-preregistration.js";
import { readRunJournalEntries } from "../run/journal.js";
import { requireRunState } from "../run/state.js";
import { assertKnownFlags, optional, parseArgs, pathFrom, present, readJsonFile, required, type ParsedArgs } from "./args.js";
import type { CliContext, CliResult } from "./result.js";

export const USAGE = `${PRODUCT_BRANDING.displayName} — ${PRODUCT_BRANDING.tagline}

Verbs (every verb accepts --json for a machine-readable envelope):

  init             --workspace <dir> --principal <id>
  draft create     --workspace <dir> --principal <id> --name <name>
                   [--description <text>] [--id <draftId>] [--file <spec.json>]
  draft update     --workspace <dir> --principal <id> --draft <draftId> --file <patch.json>
  draft show       --workspace <dir> --principal <id> --draft <draftId>
  draft list       --workspace <dir> --principal <id>
  inspect          --workspace <dir> --principal <id> --draft <draftId>
  sample init      --workspace <dir> --principal <id> --draft <draftId>
  import swebench  --workspace <dir> --principal <id> --draft <draftId> --file <rows.json>
                   [--name <name>] [--description <text>] [--version <ver>]
                   [--provenance-timestamp <rfc3339>]
  runtime inspect select --workspace <dir> --principal <id> --draft <draftId>
                   --file <selection.json>
  runtime harbor select --workspace <dir> --principal <id> --draft <draftId>
                   --file <selection.json>
  runtime terminal-bench-2 select --workspace <dir> --principal <id> --draft <draftId>
                   --file <selection.json>
  runtime terminal-bench migrate --workspace <dir> --principal <id> --file <migration.json>
  arm add          --workspace <dir> --principal <id> --draft <draftId>
                   --arm <armId> --pinning <json> [--notes <text>]
  arm update       --workspace <dir> --principal <id> --draft <draftId>
                   --arm <armId> [--pinning <json>] [--notes <text>]
  arm remove       --workspace <dir> --principal <id> --draft <draftId> --arm <armId>
  arm list         --workspace <dir> --principal <id> --draft <draftId>
  authority grant  --workspace <dir> --principal <id> --grantee <id>
                   [--role sponsor|delegated-agent] [--operations <csv>]
  authority revoke --workspace <dir> --principal <id> --grantee <id> [--operations <csv>]
  authority show   --workspace <dir> --principal <id>
  preview          --workspace <dir> --principal <id> --draft <draftId> [--items <n>]
  quote            --workspace <dir> --principal <id> --draft <draftId>
  lock             --workspace <dir> --principal <id> --draft <draftId>
  publication configure --workspace <dir> --principal <id> --draft <draftId> --public-base-url <url>
  publication register  --workspace <dir> --principal <id> --draft <draftId> [--public-base-url <url>]
  publication status     --workspace <dir> --principal <id> --draft <draftId>
  publication accounting --workspace <dir> --principal <id> --draft <draftId>
  publication report     --workspace <dir> --principal <id> --draft <draftId>
  launch           --workspace <dir> --principal <id> --draft <draftId>
  resume           --workspace <dir> --principal <id> --draft <draftId>
  cancel           --workspace <dir> --principal <id> --draft <draftId>
  status           --workspace <dir> --principal <id> --draft <draftId>
  collect          --workspace <dir> --principal <id> --draft <draftId>
  results          --workspace <dir> --principal <id> --draft <draftId>
  report           --workspace <dir> --principal <id> --draft <draftId>
  verify           --workspace <dir> --principal <id> --draft <draftId>
  publish          --workspace <dir> --principal <id> --draft <draftId>
                   [--include-native-artifacts]
  bundle verify    --bundle <dir> [--json]
  demo1 prereg verify --workspace <dir> --draft <draftId> --witness <witness.json>
                   --method-summary-sha256 <sha256> --grader-program-sha256 <sha256>
                   --source-commit <full-git-oid> [--json]
  help                  (also: --help, or no arguments)

Exit codes: 0 success, 2 invalid-invocation, 3 authority-denied, 1 any other typed error.
`;

const INIT_FLAGS = ["workspace", "principal", "json"] as const;
const DRAFT_CREATE_FLAGS = ["workspace", "principal", "json", "name", "description", "id", "file"] as const;
const DRAFT_UPDATE_FLAGS = ["workspace", "principal", "json", "draft", "file"] as const;
const DRAFT_SHOW_FLAGS = ["workspace", "principal", "json", "draft"] as const;
const DRAFT_LIST_FLAGS = ["workspace", "principal", "json"] as const;
const INSPECT_FLAGS = ["workspace", "principal", "json", "draft"] as const;
const SAMPLE_INIT_FLAGS = ["workspace", "principal", "json", "draft"] as const;
const IMPORT_SWEBENCH_FLAGS = [
  "workspace", "principal", "json", "draft", "file", "name", "description", "version", "provenance-timestamp",
] as const;
const RUNTIME_INSPECT_SELECT_FLAGS = ["workspace", "principal", "json", "draft", "file"] as const;
const RUNTIME_HARBOR_SELECT_FLAGS = ["workspace", "principal", "json", "draft", "file"] as const;
const RUNTIME_TERMINAL_BENCH_2_SELECT_FLAGS = ["workspace", "principal", "json", "draft", "file"] as const;
const RUNTIME_TERMINAL_BENCH_MIGRATE_FLAGS = ["workspace", "principal", "json", "file"] as const;
const ARM_ADD_FLAGS = ["workspace", "principal", "json", "draft", "arm", "pinning", "notes"] as const;
const ARM_UPDATE_FLAGS = ["workspace", "principal", "json", "draft", "arm", "pinning", "notes"] as const;
const ARM_REMOVE_FLAGS = ["workspace", "principal", "json", "draft", "arm"] as const;
const ARM_LIST_FLAGS = ["workspace", "principal", "json", "draft"] as const;
const AUTHORITY_GRANT_FLAGS = ["workspace", "principal", "json", "grantee", "role", "operations"] as const;
const AUTHORITY_REVOKE_FLAGS = ["workspace", "principal", "json", "grantee", "operations"] as const;
const AUTHORITY_SHOW_FLAGS = ["workspace", "principal", "json"] as const;
const PREVIEW_FLAGS = ["workspace", "principal", "json", "draft", "items"] as const;
const QUOTE_FLAGS = ["workspace", "principal", "json", "draft"] as const;
const LOCK_FLAGS = ["workspace", "principal", "json", "draft"] as const;
const PUBLICATION_CONFIGURE_FLAGS = ["workspace", "principal", "json", "draft", "public-base-url"] as const;
const PUBLICATION_REGISTER_FLAGS = ["workspace", "principal", "json", "draft", "public-base-url"] as const;
const PUBLICATION_STATUS_FLAGS = ["workspace", "principal", "json", "draft"] as const;
const PUBLICATION_ACCOUNTING_FLAGS = ["workspace", "principal", "json", "draft"] as const;
const PUBLICATION_REPORT_FLAGS = ["workspace", "principal", "json", "draft"] as const;
const LAUNCH_FLAGS = ["workspace", "principal", "json", "draft"] as const;
const RESUME_FLAGS = ["workspace", "principal", "json", "draft"] as const;
const CANCEL_FLAGS = ["workspace", "principal", "json", "draft"] as const;
const STATUS_FLAGS = ["workspace", "principal", "json", "draft"] as const;
const COLLECT_FLAGS = ["workspace", "principal", "json", "draft"] as const;
const RESULTS_FLAGS = ["workspace", "principal", "json", "draft"] as const;
const REPORT_FLAGS = ["workspace", "principal", "json", "draft"] as const;
const VERIFY_FLAGS = ["workspace", "principal", "json", "draft"] as const;
const PUBLISH_FLAGS = ["workspace", "principal", "json", "draft", "include-native-artifacts"] as const;
const BUNDLE_VERIFY_FLAGS = ["bundle", "json"] as const;
const DEMO1_PREREG_VERIFY_FLAGS = [
  "workspace", "draft", "witness", "method-summary-sha256", "grader-program-sha256", "source-commit", "json",
] as const;

/** Exit-code table (spec §4.3, §5.2): distinct codes so a caller can branch without parsing stdout. */
function exitCodeFor(code: ProductErrorCode): number {
  if (code === "invalid-invocation") return 2;
  if (code === "authority-denied") return 3;
  return 1;
}

function renderHumanError(error: ProductErrorEnvelope): string {
  const lines = [`error (${error.code}): ${error.detail}`];
  for (const issue of error.issues ?? []) {
    lines.push(`  ${issue.path}: ${issue.message}`);
  }
  return `${lines.join("\n")}\n`;
}

/** Renders an `OperationResult` to a `CliResult`: the envelope verbatim in `--json` mode, plain text otherwise. */
function renderResult<T>(result: OperationResult<T>, jsonMode: boolean, humanSuccess: (value: T) => string): CliResult {
  if (result.ok) {
    if (jsonMode) return { exitCode: 0, stdout: `${JSON.stringify(result)}\n`, stderr: "" };
    return { exitCode: 0, stdout: humanSuccess(result.result), stderr: "" };
  }
  const exitCode = exitCodeFor(result.error.code);
  if (jsonMode) return { exitCode, stdout: `${JSON.stringify(result)}\n`, stderr: "" };
  return { exitCode, stdout: "", stderr: renderHumanError(result.error) };
}

/** Every operational verb requires `--workspace` and `--principal` (spec §5.2). */
function buildOperationContext(args: ParsedArgs, context: CliContext): OperationContext {
  const workspaceDir = pathFrom(context.cwd, required(args, "workspace"));
  const principal = required(args, "principal");
  return {
    workspaceDir,
    principal,
    clock: context.clock,
    ...(context.runtimeHost === undefined ? {} : { runtimeHost: context.runtimeHost }),
  };
}

/** Renders `warnings` (arm mutations, spec: duplicate-pinning is a surface, not a refusal) as human-mode lines. */
function armWarningLines(warnings: readonly ArmWarning[]): readonly string[] {
  return warnings.map((warning) => `warning (${warning.code}): ${warning.detail}`);
}

/** Parses an inline `--pinning` JSON string; refuses `"invalid-invocation"` naming `--pinning` on malformed JSON. */
function parsePinningFlag(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    refuse("invalid-invocation", "--pinning", "--pinning must be valid JSON");
  }
}

/** Refuses `"invalid-invocation"` naming `--role` unless it is one of the two valid role names. */
function assertRole(value: string): "sponsor" | "delegated-agent" {
  if (value === "sponsor" || value === "delegated-agent") return value;
  refuse("invalid-invocation", "--role", `--role must be "sponsor" or "delegated-agent"`);
}

/** Splits a comma-separated `--operations` value, trimming and dropping empty entries. */
function parseOperationsList(raw: string): readonly string[] {
  return raw
    .split(",")
    .map((token) => token.trim())
    .filter((token) => token.length > 0);
}

/** Parses `--items`; refuses `"invalid-invocation"` naming `--items` unless it is a positive integer. */
function parseItemsFlag(raw: string): number {
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) {
    refuse("invalid-invocation", "--items", "--items must be a positive integer");
  }
  return value;
}

function handleInit(args: ParsedArgs, context: CliContext, jsonMode: boolean): CliResult {
  assertKnownFlags(args, INIT_FLAGS);
  const opContext = buildOperationContext(args, context);
  const result = initWorkspace(opContext);
  return renderResult(result, jsonMode, () => `initialized workspace at ${opContext.workspaceDir}\n`);
}

function handleDraftCreate(args: ParsedArgs, context: CliContext, jsonMode: boolean): CliResult {
  assertKnownFlags(args, DRAFT_CREATE_FLAGS);
  const opContext = buildOperationContext(args, context);
  const name = required(args, "name");
  const description = optional(args, "description");
  const draftId = optional(args, "id");
  const filePath = optional(args, "file");
  const spec = filePath === undefined ? undefined : readJsonFile(pathFrom(context.cwd, filePath));

  const result = createDraft(opContext, { name, description, draftId, spec });
  return renderResult(result, jsonMode, (value) => `created draft ${value.draft.draftId} (${value.draft.state})\n`);
}

function handleDraftUpdate(args: ParsedArgs, context: CliContext, jsonMode: boolean): CliResult {
  assertKnownFlags(args, DRAFT_UPDATE_FLAGS);
  const opContext = buildOperationContext(args, context);
  const draftId = required(args, "draft");
  const filePath = required(args, "file");
  const patch = readJsonFile(pathFrom(context.cwd, filePath));

  const result = updateDraft(opContext, { draftId, patch });
  return renderResult(result, jsonMode, (value) => `updated draft ${value.draft.draftId} (${value.draft.state})\n`);
}

function handleDraftShow(args: ParsedArgs, context: CliContext, jsonMode: boolean): CliResult {
  assertKnownFlags(args, DRAFT_SHOW_FLAGS);
  const opContext = buildOperationContext(args, context);
  const draftId = required(args, "draft");

  const result = getDraft(opContext, { draftId });
  return renderResult(result, jsonMode, (value) => `${JSON.stringify(value, null, 2)}\n`);
}

function handleDraftList(args: ParsedArgs, context: CliContext, jsonMode: boolean): CliResult {
  assertKnownFlags(args, DRAFT_LIST_FLAGS);
  const opContext = buildOperationContext(args, context);

  const result = listDrafts(opContext);
  return renderResult(result, jsonMode, (value) => {
    if (value.drafts.length === 0) return "no drafts\n";
    return `${value.drafts.map((draft) => `${draft.draftId}\t${draft.state}\t${draft.name}`).join("\n")}\n`;
  });
}

function handleInspect(args: ParsedArgs, context: CliContext, jsonMode: boolean): CliResult {
  assertKnownFlags(args, INSPECT_FLAGS);
  const opContext = buildOperationContext(args, context);
  const draftId = required(args, "draft");

  const result = inspectDraft(opContext, { draftId });
  return renderResult(result, jsonMode, (value) => `${JSON.stringify(value, null, 2)}\n`);
}

async function handleSampleInit(args: ParsedArgs, context: CliContext, jsonMode: boolean): Promise<CliResult> {
  assertKnownFlags(args, SAMPLE_INIT_FLAGS);
  const opContext = buildOperationContext(args, context);
  const draftId = required(args, "draft");

  const result = await sampleInit(opContext, { draftId });
  return renderResult(
    result,
    jsonMode,
    (value) =>
      `attached sample benchmark ${value.benchmarkSha256} (${value.tasks.length} tasks) to draft ${value.draft.draftId}\n`,
  );
}

function handleImportSweBench(args: ParsedArgs, context: CliContext, jsonMode: boolean): CliResult {
  assertKnownFlags(args, IMPORT_SWEBENCH_FLAGS);
  const opContext = buildOperationContext(args, context);
  const draftId = required(args, "draft");
  const filePath = required(args, "file");
  const rows = readJsonFile(pathFrom(context.cwd, filePath));
  const name = optional(args, "name");
  const description = optional(args, "description");
  const version = optional(args, "version");
  const provenanceTimestamp = optional(args, "provenance-timestamp");

  const result = importSweBenchRows(opContext, {
    draftId,
    rows,
    ...(name !== undefined ? { name } : {}),
    ...(description !== undefined ? { description } : {}),
    ...(version !== undefined ? { version } : {}),
    ...(provenanceTimestamp !== undefined ? { provenanceTimestamp } : {}),
  });
  return renderResult(
    result,
    jsonMode,
    (value) =>
      `imported ${value.taskSha256s.length} task(s) as benchmark ${value.benchmarkSha256} into draft ${value.draft.draftId}\n`,
  );
}

async function handleInspectRuntimeSelect(
  args: ParsedArgs,
  context: CliContext,
  jsonMode: boolean,
): Promise<CliResult> {
  assertKnownFlags(args, RUNTIME_INSPECT_SELECT_FLAGS);
  const opContext = buildOperationContext(args, context);
  const draftId = required(args, "draft");
  const configuration = readJsonFile(pathFrom(context.cwd, required(args, "file"))) as Omit<
    SelectInspectEvaluationInput,
    "draftId"
  >;
  const result = await selectInspectEvaluation(opContext, { draftId, ...configuration } as SelectInspectEvaluationInput);
  return renderResult(
    result,
    jsonMode,
    (value) => `selected Inspect evaluation ${value.selectionManifestSha256} for draft ${draftId}\n`,
  );
}

async function handleTerminalBench2RuntimeSelect(args: ParsedArgs, context: CliContext, jsonMode: boolean): Promise<CliResult> {
  assertKnownFlags(args, RUNTIME_TERMINAL_BENCH_2_SELECT_FLAGS);
  const opContext = buildOperationContext(args, context);
  const draftId = required(args, "draft");
  const configuration = readJsonFile(pathFrom(context.cwd, required(args, "file"))) as Omit<SelectTerminalBench2RuntimeInput, "draftId">;
  const result = await selectTerminalBench2Runtime(opContext, { draftId, ...configuration } as SelectTerminalBench2RuntimeInput);
  return renderResult(result, jsonMode, (value) => `selected Terminal-Bench 2 profile ${value.terminalBench2ProfileSha256} for draft ${draftId}\n`);
}

async function handleHarborRuntimeSelect(args: ParsedArgs, context: CliContext, jsonMode: boolean): Promise<CliResult> {
  assertKnownFlags(args, RUNTIME_HARBOR_SELECT_FLAGS);
  const opContext = buildOperationContext(args, context);
  const draftId = required(args, "draft");
  const configuration = readJsonFile(pathFrom(context.cwd, required(args, "file"))) as Omit<SelectHarborRuntimeInput, "draftId">;
  const result = await selectHarborRuntime(opContext, { draftId, ...configuration } as SelectHarborRuntimeInput);
  return renderResult(result, jsonMode, (value) => `selected Harbor runtime ${value.selectionManifestSha256} for draft ${draftId}\n`);
}

async function handleTerminalBenchMigration(args: ParsedArgs, context: CliContext, jsonMode: boolean): Promise<CliResult> {
  assertKnownFlags(args, RUNTIME_TERMINAL_BENCH_MIGRATE_FLAGS);
  const opContext = buildOperationContext(args, context);
  const configuration = readJsonFile(pathFrom(context.cwd, required(args, "file"))) as MigrateTerminalBenchLegacyTaskInput;
  const result = await migrateTerminalBenchLegacyTask(opContext, configuration);
  return renderResult(result, jsonMode, (value) => `migrated legacy Terminal-Bench task as ${value.manifestSha256}\n`);
}

function handleArmAdd(args: ParsedArgs, context: CliContext, jsonMode: boolean): CliResult {
  assertKnownFlags(args, ARM_ADD_FLAGS);
  const opContext = buildOperationContext(args, context);
  const draftId = required(args, "draft");
  const armId = required(args, "arm");
  const pinning = parsePinningFlag(required(args, "pinning"));
  const notes = optional(args, "notes");

  const result = armAdd(opContext, { draftId, armId, pinning, ...(notes !== undefined ? { notes } : {}) });
  return renderResult(result, jsonMode, (value) => {
    const lines = [`added arm ${armId} to draft ${draftId}`, ...armWarningLines(value.warnings)];
    return `${lines.join("\n")}\n`;
  });
}

function handleArmUpdate(args: ParsedArgs, context: CliContext, jsonMode: boolean): CliResult {
  assertKnownFlags(args, ARM_UPDATE_FLAGS);
  const opContext = buildOperationContext(args, context);
  const draftId = required(args, "draft");
  const armId = required(args, "arm");
  const pinningRaw = optional(args, "pinning");
  const notes = optional(args, "notes");
  if (pinningRaw === undefined && notes === undefined) {
    refuse("invalid-invocation", "arm update", "supply --pinning and/or --notes");
  }
  const pinning = pinningRaw === undefined ? undefined : parsePinningFlag(pinningRaw);

  const result = armUpdate(opContext, {
    draftId,
    armId,
    ...(pinning !== undefined ? { pinning } : {}),
    ...(notes !== undefined ? { notes } : {}),
  });
  return renderResult(result, jsonMode, (value) => {
    const lines = [`updated arm ${armId} on draft ${draftId}`, ...armWarningLines(value.warnings)];
    return `${lines.join("\n")}\n`;
  });
}

function handleArmRemove(args: ParsedArgs, context: CliContext, jsonMode: boolean): CliResult {
  assertKnownFlags(args, ARM_REMOVE_FLAGS);
  const opContext = buildOperationContext(args, context);
  const draftId = required(args, "draft");
  const armId = required(args, "arm");

  const result = armRemove(opContext, { draftId, armId });
  return renderResult(result, jsonMode, (value) => {
    const lines = [`removed arm ${armId} from draft ${draftId}`, ...armWarningLines(value.warnings)];
    return `${lines.join("\n")}\n`;
  });
}

function handleArmList(args: ParsedArgs, context: CliContext, jsonMode: boolean): CliResult {
  assertKnownFlags(args, ARM_LIST_FLAGS);
  const opContext = buildOperationContext(args, context);
  const draftId = required(args, "draft");

  const result = armList(opContext, { draftId });
  return renderResult(result, jsonMode, (value) => {
    if (value.arms.length === 0) return "no arms\n";
    const lines = [
      ...value.arms.map((arm) => `${arm.armId}\t${JSON.stringify(arm.pinning)}`),
      ...armWarningLines(value.warnings),
    ];
    return `${lines.join("\n")}\n`;
  });
}

function handleAuthorityGrant(args: ParsedArgs, context: CliContext, jsonMode: boolean): CliResult {
  assertKnownFlags(args, AUTHORITY_GRANT_FLAGS);
  const opContext = buildOperationContext(args, context);
  const grantee = required(args, "grantee");
  const roleRaw = optional(args, "role");
  const role = roleRaw === undefined ? undefined : assertRole(roleRaw);
  const operationsRaw = optional(args, "operations");
  const operations = operationsRaw === undefined ? [] : parseOperationsList(operationsRaw);

  const result = authorityGrant(opContext, {
    principalId: grantee,
    ...(role !== undefined ? { role } : {}),
    operations,
  });
  return renderResult(result, jsonMode, () => `granted ${grantee}\n`);
}

function handleAuthorityRevoke(args: ParsedArgs, context: CliContext, jsonMode: boolean): CliResult {
  assertKnownFlags(args, AUTHORITY_REVOKE_FLAGS);
  const opContext = buildOperationContext(args, context);
  const grantee = required(args, "grantee");
  const operationsRaw = optional(args, "operations");
  const operations = operationsRaw === undefined ? undefined : parseOperationsList(operationsRaw);

  const result = authorityRevoke(opContext, {
    principalId: grantee,
    ...(operations !== undefined ? { operations } : {}),
  });
  return renderResult(result, jsonMode, () => `revoked ${grantee}\n`);
}

function handleAuthorityShow(args: ParsedArgs, context: CliContext, jsonMode: boolean): CliResult {
  assertKnownFlags(args, AUTHORITY_SHOW_FLAGS);
  const opContext = buildOperationContext(args, context);

  const result = authorityShow(opContext);
  return renderResult(result, jsonMode, (value) => `${JSON.stringify(value, null, 2)}\n`);
}

// ── BP-20: preview (disposable rehearsal, spec §7.2) ──────────────────────────────────────────

async function handlePreview(args: ParsedArgs, context: CliContext, jsonMode: boolean): Promise<CliResult> {
  assertKnownFlags(args, PREVIEW_FLAGS);
  const opContext = buildOperationContext(args, context);
  const draftId = required(args, "draft");
  const itemsRaw = optional(args, "items");
  const items = itemsRaw === undefined ? undefined : parseItemsFlag(itemsRaw);

  const result = await runPreview(opContext, { draftId, ...(items !== undefined ? { items } : {}) });
  return renderResult(result, jsonMode, (value) => {
    const { preview } = value;
    const lines = [
      `previewed draft ${value.draft.draftId}: ${preview.previewId}, ${preview.cellCount} rehearsal cell(s) `
        + `across ${preview.arms.length} arm(s) — rehearsal, not official evidence`,
    ];
    for (const arm of preview.arms) {
      const parts = [`${arm.outcomes.delivered} delivered`, `${arm.outcomes.failed} failed`];
      if (arm.outcomes.expired > 0) parts.push(`${arm.outcomes.expired} expired`);
      if (arm.outcomes.cancelled > 0) parts.push(`${arm.outcomes.cancelled} cancelled`);
      lines.push(`  ${arm.armId}: ${parts.join(", ")}`);
    }
    return `${lines.join("\n")}\n`;
  });
}

// ── BP-13: run-path verbs (quote through verify) ─────────────────────────────────────────────

/** Renders `presentation` (BP-20, spec §4.6 Quote row) as human-mode lines: run size overall and
 * per arm, coverage (supported keys, and any refusals), the hard-cap check, and — only when this
 * draft has disclosed preview history — a wall-time estimate (never an invented one). */
function renderQuotePresentation(presentation: QuotePresentation): readonly string[] {
  const { runSize, coverage, hardCap, estimatedWallTime } = presentation;
  const lines = [`run size: ${runSize.solveCells} solve + ${runSize.evaluationCells} evaluation = ${runSize.totalCells} cells`];
  for (const arm of runSize.perArm) {
    lines.push(`  ${arm.armId}: ${arm.solveCells} solve + ${arm.evaluationCells} evaluation`);
  }
  lines.push(`coverage: supported keys ${coverage.supportedKeys.join(", ")}`);
  for (const refusal of coverage.refusals) {
    lines.push(`  refused ${refusal.armId}/${refusal.key}: ${refusal.detail}`);
  }
  if (!hardCap.declared) {
    lines.push("hard cap: not declared");
  } else if (hardCap.breached) {
    lines.push(`hard cap: BREACHED — ${hardCap.detail}`);
  } else {
    lines.push("hard cap: within cap");
  }
  if (estimatedWallTime !== undefined) {
    lines.push(
      `estimated wall time (from ${estimatedWallTime.previewCount} rehearsal preview(s)): `
        + `~${estimatedWallTime.projectedSolveMs} ms solve total (${estimatedWallTime.meanCellMs} ms/cell `
        + `over ${estimatedWallTime.rehearsedCells} rehearsed cells)`,
    );
  }
  return lines;
}

async function handleQuote(args: ParsedArgs, context: CliContext, jsonMode: boolean): Promise<CliResult> {
  assertKnownFlags(args, QUOTE_FLAGS);
  const opContext = buildOperationContext(args, context);
  const draftId = required(args, "draft");

  const result = await runQuote(opContext, { draftId });
  return renderResult(result, jsonMode, (value) => {
    const lines = [`quoted draft ${value.draft.draftId}: ${value.quote.expectedCellCount} cells, ok=${value.quote.ok}`];
    for (const error of value.quote.errors) {
      lines.push(`${error.code}: ${error.detail}`);
    }
    lines.push(...renderQuotePresentation(value.presentation));
    return `${lines.join("\n")}\n`;
  });
}

function handleLock(args: ParsedArgs, context: CliContext, jsonMode: boolean): CliResult {
  assertKnownFlags(args, LOCK_FLAGS);
  const opContext = buildOperationContext(args, context);
  const draftId = required(args, "draft");

  const result = runLock(opContext, { draftId });
  return renderResult(
    result,
    jsonMode,
    (value) => `locked draft ${value.draft.draftId}: run ${value.runSha256}, closes ${value.closeAt}\n`,
  );
}

async function handlePublicationConfigure(args: ParsedArgs, context: CliContext, jsonMode: boolean): Promise<CliResult> {
  assertKnownFlags(args, PUBLICATION_CONFIGURE_FLAGS);
  const opContext = buildOperationContext(args, context);
  const result = await publicationConfigure(opContext, { draftId: required(args, "draft"), publicBaseUrl: required(args, "public-base-url") });
  return renderResult(result, jsonMode, (value) => `configured public source at ${value.publicBaseUrl}; launch is now gated on prospective registration completing before dispatch\n`);
}

async function handlePublicationRegister(args: ParsedArgs, context: CliContext, jsonMode: boolean): Promise<CliResult> {
  assertKnownFlags(args, PUBLICATION_REGISTER_FLAGS);
  const opContext = buildOperationContext(args, context);
  const result = await publicationRegister(opContext, {
    draftId: required(args, "draft"),
    ...(optional(args, "public-base-url") === undefined ? {} : { publicBaseUrl: optional(args, "public-base-url")! }),
  });
  return renderResult(result, jsonMode, (value) => value.postHoc
    ? `registered run ${value.recordSha256} at ${value.source.agent}/${value.source.name}#${value.sourceSequence} post-hoc; this does not rerun completed work\n`
    : `registered run ${value.recordSha256} at ${value.source.agent}/${value.source.name}#${value.sourceSequence} before dispatch\n`);
}

function handlePublicationStatus(args: ParsedArgs, context: CliContext, jsonMode: boolean): CliResult {
  assertKnownFlags(args, PUBLICATION_STATUS_FLAGS);
  const result = publicationStatus(buildOperationContext(args, context), { draftId: required(args, "draft") });
  return renderResult(result, jsonMode, (value) => {
    const stages = value.stages.map((stage) => `${stage.name}=${stage.state}`).join(", ");
    return `publication mode=${value.mode}; analysis=${value.analysisPreregistration}; registration=${value.registrationTiming}; ${stages}\n${value.recovery.guidance}\n`;
  });
}

async function handlePublicationAccounting(args: ParsedArgs, context: CliContext, jsonMode: boolean): Promise<CliResult> {
  assertKnownFlags(args, PUBLICATION_ACCOUNTING_FLAGS);
  const result = await publicationAccounting(buildOperationContext(args, context), { draftId: required(args, "draft") });
  return renderResult(result, jsonMode, (value) => `published accounting ${value.accountingSha256} and Matrix v2 ${value.matrixV2Sha256}; accounting does not require a Report and does not rerun work\n`);
}

async function handlePublicationReport(args: ParsedArgs, context: CliContext, jsonMode: boolean): Promise<CliResult> {
  assertKnownFlags(args, PUBLICATION_REPORT_FLAGS);
  const opContext = buildOperationContext(args, context);
  const result = await publicationReport(opContext, { draftId: required(args, "draft") });
  return renderResult(result, jsonMode, (value) =>
    `published signed Report v2 ${value.reportRecordSha256} (payload ${value.reportPayloadSha256}) at ${value.source.agent}/${value.source.name}#${value.receipt.sourceSequence}\n`);
}

/** `launch`'s `RunLaunchDeps`: `onProgress` streams to `context.progress` in human mode only —
 * `--json` mode's stdout stays the single machine-parseable envelope (module header). */
function launchDeps(context: CliContext, jsonMode: boolean): RunLaunchDeps {
  return jsonMode ? {} : { onProgress: context.progress };
}

async function handleLaunch(args: ParsedArgs, context: CliContext, jsonMode: boolean): Promise<CliResult> {
  assertKnownFlags(args, LAUNCH_FLAGS);
  const opContext = buildOperationContext(args, context);
  const draftId = required(args, "draft");

  const result = await runLaunch(opContext, { draftId }, launchDeps(context, jsonMode));
  return renderResult(result, jsonMode, (value) => `launched draft ${value.draft.draftId}: run complete\n`);
}

async function handleResume(args: ParsedArgs, context: CliContext, jsonMode: boolean): Promise<CliResult> {
  assertKnownFlags(args, RESUME_FLAGS);
  const opContext = buildOperationContext(args, context);
  const draftId = required(args, "draft");

  const result = await runResume(opContext, { draftId }, launchDeps(context, jsonMode));
  return renderResult(
    result,
    jsonMode,
    (value) => `resumed draft ${draftId}: ${value.outstandingCount} outstanding, ${value.evaluationCatchUpCount} evaluation catch-ups\n`,
  );
}

async function handleCancel(args: ParsedArgs, context: CliContext, jsonMode: boolean): Promise<CliResult> {
  assertKnownFlags(args, CANCEL_FLAGS);
  const opContext = buildOperationContext(args, context);
  const draftId = required(args, "draft");

  const result = await runCancel(opContext, { draftId });
  return renderResult(result, jsonMode, (value) =>
    value.phase === "requested"
      ? `cancellation requested for draft ${draftId}; the active driver is draining — run cancel again to finalize\n`
      : `cancelled draft ${draftId}: matrix ${value.matrixSha256}\n`,
  );
}

function handleStatus(args: ParsedArgs, context: CliContext, jsonMode: boolean): CliResult {
  assertKnownFlags(args, STATUS_FLAGS);
  const opContext = buildOperationContext(args, context);
  const draftId = required(args, "draft");

  const result = runStatus(opContext, { draftId });
  return renderResult(result, jsonMode, (value) => {
    const lines = [
      value.closeAt !== undefined ? `state ${value.state}, closeAt ${value.closeAt}` : `state ${value.state}`,
      ...value.cells.map((cell) => `${cell.cellKey}\t${cell.status}\t${cell.dispatches}`),
      `expected ${value.counts.expected}, dispatched ${value.counts.dispatched}, delivered ${value.counts.delivered}, `
        + `judged ${value.counts.judged}, failed ${value.counts.failed}`,
    ];
    return `${lines.join("\n")}\n`;
  });
}

async function handleCollect(args: ParsedArgs, context: CliContext, jsonMode: boolean): Promise<CliResult> {
  assertKnownFlags(args, COLLECT_FLAGS);
  const opContext = buildOperationContext(args, context);
  const draftId = required(args, "draft");

  const result = await runCollect(opContext, { draftId });
  return renderResult(result, jsonMode, (value) => `collected draft ${value.draft.draftId}: matrix ${value.matrixSha256}\n`);
}

function handleResults(args: ParsedArgs, context: CliContext, jsonMode: boolean): CliResult {
  assertKnownFlags(args, RESULTS_FLAGS);
  const opContext = buildOperationContext(args, context);
  const draftId = required(args, "draft");

  const result = runResults(opContext, { draftId });
  return renderResult(result, jsonMode, (value) => `${JSON.stringify(value, null, 2)}\n`);
}

async function handleReport(args: ParsedArgs, context: CliContext, jsonMode: boolean): Promise<CliResult> {
  assertKnownFlags(args, REPORT_FLAGS);
  const opContext = buildOperationContext(args, context);
  const draftId = required(args, "draft");

  const result = await runReport(opContext, { draftId });
  return renderResult(
    result,
    jsonMode,
    (value) =>
      `reported draft ${value.draft.draftId}: report ${value.reportSha256}, preregistered=${value.preregistered}, claim written\n`,
  );
}

async function handleVerify(args: ParsedArgs, context: CliContext, jsonMode: boolean): Promise<CliResult> {
  assertKnownFlags(args, VERIFY_FLAGS);
  const opContext = buildOperationContext(args, context);
  const draftId = required(args, "draft");

  const result = await runVerify(opContext, { draftId });
  return renderResult(result, jsonMode, (value) => `verified draft ${value.draftId}: ${value.checks.join(", ")}\n`);
}

async function handlePublish(args: ParsedArgs, context: CliContext, jsonMode: boolean): Promise<CliResult> {
  assertKnownFlags(args, PUBLISH_FLAGS);
  const opContext = buildOperationContext(args, context);
  const draftId = required(args, "draft");
  const result = await runPublish(opContext, {
    draftId,
    ...(present(args, "include-native-artifacts") ? { includeNativeArtifacts: true } : {}),
  });
  return renderResult(
    result,
    jsonMode,
    (value) => `published draft ${draftId}: bundle ${value.bundleIdentity} at ${value.bundleRelativePath}\n`,
  );
}

async function handleBundleVerify(args: ParsedArgs, context: CliContext, jsonMode: boolean): Promise<CliResult> {
  assertKnownFlags(args, BUNDLE_VERIFY_FLAGS);
  const bundleDir = pathFrom(context.cwd, required(args, "bundle"));
  const result = await verifyPublicBundle(bundleDir);
  return renderResult(
    { ok: true, result },
    jsonMode,
    (value) => `verified public bundle ${value.identity}: ${value.checks.join(", ")}\n`,
  );
}

function handleDemo1PreregistrationVerify(
  args: ParsedArgs,
  context: CliContext,
  jsonMode: boolean,
): CliResult {
  assertKnownFlags(args, DEMO1_PREREG_VERIFY_FLAGS);
  const workspaceDir = pathFrom(context.cwd, required(args, "workspace"));
  const draftId = required(args, "draft");
  const runState = requireRunState(workspaceDir, draftId);
  if (runState.runSha256 === undefined) {
    refuse("illegal-transition", `runs.${draftId}`, "Demo-1 preregistration verification requires a sealed Run");
  }
  const result = verifyDemo1PreregistrationPreDispatch({
    commitment: {
      runSha256: runState.runSha256,
      methodSummarySha256: required(args, "method-summary-sha256"),
      graderProgramSha256: required(args, "grader-program-sha256"),
      sourceCommit: required(args, "source-commit"),
    },
    witness: readJsonFile(pathFrom(context.cwd, required(args, "witness"))),
    runState,
    journal: readRunJournalEntries(workspaceDir, draftId),
  });
  return renderResult(
    { ok: true, result },
    jsonMode,
    (value) => `Demo-1 preregistration ready (${value.stage}): ${value.manifestCid} / ${value.transactionHash}\n`,
  );
}

type VerbHandler = (args: ParsedArgs, context: CliContext, jsonMode: boolean) => CliResult | Promise<CliResult>;

const VERBS: ReadonlyMap<string, VerbHandler> = new Map<string, VerbHandler>([
  ["init", handleInit],
  ["draft create", handleDraftCreate],
  ["draft update", handleDraftUpdate],
  ["draft show", handleDraftShow],
  ["draft list", handleDraftList],
  ["inspect", handleInspect],
  ["sample init", handleSampleInit],
  ["import swebench", handleImportSweBench],
  ["runtime inspect select", handleInspectRuntimeSelect],
  ["runtime harbor select", handleHarborRuntimeSelect],
  ["runtime terminal-bench-2 select", handleTerminalBench2RuntimeSelect],
  ["runtime terminal-bench migrate", handleTerminalBenchMigration],
  ["arm add", handleArmAdd],
  ["arm update", handleArmUpdate],
  ["arm remove", handleArmRemove],
  ["arm list", handleArmList],
  ["authority grant", handleAuthorityGrant],
  ["authority revoke", handleAuthorityRevoke],
  ["authority show", handleAuthorityShow],
  ["preview", handlePreview],
  ["quote", handleQuote],
  ["lock", handleLock],
  ["publication configure", handlePublicationConfigure],
  ["publication register", handlePublicationRegister],
  ["publication status", handlePublicationStatus],
  ["publication accounting", handlePublicationAccounting],
  ["publication report", handlePublicationReport],
  ["launch", handleLaunch],
  ["resume", handleResume],
  ["cancel", handleCancel],
  ["status", handleStatus],
  ["collect", handleCollect],
  ["results", handleResults],
  ["report", handleReport],
  ["verify", handleVerify],
  ["publish", handlePublish],
  ["bundle verify", handleBundleVerify],
  ["demo1 prereg verify", handleDemo1PreregistrationVerify],
]);

/** The complete verb surface, derived from `VERBS` — the parity anchor `./parity.test.ts` checks
 * every operations-facade export maps onto (module header). */
export const CLI_VERB_NAMES: readonly string[] = [...VERBS.keys()];

function usageResult(jsonMode: boolean): CliResult {
  if (jsonMode) {
    return { exitCode: 0, stdout: `${JSON.stringify({ ok: true, result: { usage: USAGE } })}\n`, stderr: "" };
  }
  return { exitCode: 0, stdout: USAGE, stderr: "" };
}

/**
 * An unknown verb refuses `"invalid-invocation"` (exit 2). The `--json`
 * detail stays a single sentence naming the unknown verb — a machine caller
 * does not want the usage prose folded into a field it may log verbatim —
 * while the human-mode message appends the full usage text, since a human
 * typing the wrong verb wants the verb table right there.
 */
function unknownVerbResult(verbKey: string, jsonMode: boolean): CliResult {
  const sentence = `unknown command "${verbKey}"`;
  if (jsonMode) {
    const error: ProductErrorEnvelope = { code: "invalid-invocation", detail: sentence };
    return { exitCode: 2, stdout: `${JSON.stringify({ ok: false, error })}\n`, stderr: "" };
  }
  const error: ProductErrorEnvelope = { code: "invalid-invocation", detail: `${sentence}\n\n${USAGE}` };
  return { exitCode: 2, stdout: "", stderr: renderHumanError(error) };
}

function renderThrown(cause: unknown, jsonMode: boolean): CliResult {
  const error = toErrorEnvelope(cause);
  const exitCode = exitCodeFor(error.code);
  if (jsonMode) {
    return { exitCode, stdout: `${JSON.stringify({ ok: false, error })}\n`, stderr: "" };
  }
  return { exitCode, stdout: "", stderr: renderHumanError(error) };
}

/**
 * Runs one CLI invocation to completion. Never throws — every refusal from
 * argument parsing, flag validation, or the operations facade (including a
 * rejected async handler, e.g. `sample init`) is caught here and rendered as
 * a typed envelope (or, outside `--json`, a plain-text stderr line) with the
 * matching exit code. Never touches `process`; that is `bin.ts`'s job alone.
 */
export async function runCli(argv: readonly string[], context: CliContext): Promise<CliResult> {
  // `--json` is detected from the parsed flags once parsing succeeds; a parse
  // failure itself falls back to a raw argv scan so even a malformed
  // invocation with --json in it renders as an envelope rather than text.
  let jsonMode = argv.includes("--json");
  try {
    const args = parseArgs(argv);
    jsonMode = present(args, "json");

    if (args.words.length === 0 || args.words[0] === "help" || present(args, "help")) {
      return usageResult(jsonMode);
    }

    const verbKey = args.words.join(" ");
    const handler = VERBS.get(verbKey);
    if (handler === undefined) {
      return unknownVerbResult(verbKey, jsonMode);
    }
    return await handler(args, context, jsonMode);
  } catch (cause) {
    return renderThrown(cause, jsonMode);
  }
}
