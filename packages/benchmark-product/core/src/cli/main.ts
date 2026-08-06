/**
 * The CLI's dispatch table (spec §5.2) — the complete agent surface through
 * BP-13. Twenty-four operational verbs over the operations facade (`init`,
 * `draft create`, `draft update`, `draft show`, `draft list`, `inspect`,
 * `sample init`, `import swebench`, `arm add`, `arm update`, `arm remove`,
 * `arm list`, `authority grant`, `authority revoke`, `authority show`,
 * `quote`, `lock`, `launch`, `resume`, `status`, `collect`, `results`,
 * `report`, `verify`), plus `help`. Every verb takes `--json` for a
 * machine-readable envelope; every failure is a typed error envelope with a
 * distinct exit code (§4.3). `runCli` never throws and never touches
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
 * `CLI_VERB_NAMES` (BP-13) is the parity anchor `./parity.test.ts` checks
 * against the operations facade's own exports — see that test's header.
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
  runLaunch,
  runLock,
  runQuote,
  runReport,
  runResults,
  runResume,
  runStatus,
  runVerify,
  sampleInit,
  updateDraft,
  type ArmWarning,
  type OperationContext,
  type OperationResult,
  type RunLaunchDeps,
} from "../operations/index.js";
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
  quote            --workspace <dir> --principal <id> --draft <draftId>
  lock             --workspace <dir> --principal <id> --draft <draftId>
  launch           --workspace <dir> --principal <id> --draft <draftId>
  resume           --workspace <dir> --principal <id> --draft <draftId>
  status           --workspace <dir> --principal <id> --draft <draftId>
  collect          --workspace <dir> --principal <id> --draft <draftId>
  results          --workspace <dir> --principal <id> --draft <draftId>
  report           --workspace <dir> --principal <id> --draft <draftId>
  verify           --workspace <dir> --principal <id> --draft <draftId>
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
const ARM_ADD_FLAGS = ["workspace", "principal", "json", "draft", "arm", "pinning", "notes"] as const;
const ARM_UPDATE_FLAGS = ["workspace", "principal", "json", "draft", "arm", "pinning", "notes"] as const;
const ARM_REMOVE_FLAGS = ["workspace", "principal", "json", "draft", "arm"] as const;
const ARM_LIST_FLAGS = ["workspace", "principal", "json", "draft"] as const;
const AUTHORITY_GRANT_FLAGS = ["workspace", "principal", "json", "grantee", "role", "operations"] as const;
const AUTHORITY_REVOKE_FLAGS = ["workspace", "principal", "json", "grantee", "operations"] as const;
const AUTHORITY_SHOW_FLAGS = ["workspace", "principal", "json"] as const;
const QUOTE_FLAGS = ["workspace", "principal", "json", "draft"] as const;
const LOCK_FLAGS = ["workspace", "principal", "json", "draft"] as const;
const LAUNCH_FLAGS = ["workspace", "principal", "json", "draft"] as const;
const RESUME_FLAGS = ["workspace", "principal", "json", "draft"] as const;
const STATUS_FLAGS = ["workspace", "principal", "json", "draft"] as const;
const COLLECT_FLAGS = ["workspace", "principal", "json", "draft"] as const;
const RESULTS_FLAGS = ["workspace", "principal", "json", "draft"] as const;
const REPORT_FLAGS = ["workspace", "principal", "json", "draft"] as const;
const VERIFY_FLAGS = ["workspace", "principal", "json", "draft"] as const;

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
  return { workspaceDir, principal, clock: context.clock };
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

// ── BP-13: run-path verbs (quote through verify) ─────────────────────────────────────────────

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
  ["arm add", handleArmAdd],
  ["arm update", handleArmUpdate],
  ["arm remove", handleArmRemove],
  ["arm list", handleArmList],
  ["authority grant", handleAuthorityGrant],
  ["authority revoke", handleAuthorityRevoke],
  ["authority show", handleAuthorityShow],
  ["quote", handleQuote],
  ["lock", handleLock],
  ["launch", handleLaunch],
  ["resume", handleResume],
  ["status", handleStatus],
  ["collect", handleCollect],
  ["results", handleResults],
  ["report", handleReport],
  ["verify", handleVerify],
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
