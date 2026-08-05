/**
 * The CLI's dispatch table (spec §5.2) — the complete agent surface at M1.
 * Six operational verbs over the operations facade (`init`, `draft create`,
 * `draft update`, `draft show`, `draft list`, `inspect`), plus `help`. Every
 * verb takes `--json` for a machine-readable envelope; every failure is a
 * typed error envelope with a distinct exit code (§4.3). `runCli` never
 * throws and never touches `process` — `bin.ts` is the only file in this
 * package that does.
 */

import { PRODUCT_BRANDING } from "../branding.js";
import { toErrorEnvelope, type ProductErrorCode, type ProductErrorEnvelope } from "../errors.js";
import {
  createDraft,
  getDraft,
  initWorkspace,
  inspectDraft,
  listDrafts,
  updateDraft,
  type OperationContext,
  type OperationResult,
} from "../operations/index.js";
import { assertKnownFlags, optional, parseArgs, pathFrom, present, readJsonFile, required, type ParsedArgs } from "./args.js";
import type { CliContext, CliResult } from "./result.js";

export const USAGE = `${PRODUCT_BRANDING.displayName} — ${PRODUCT_BRANDING.tagline}

Verbs (every verb accepts --json for a machine-readable envelope):

  init          --workspace <dir> --principal <id>
  draft create  --workspace <dir> --principal <id> --name <name>
                [--description <text>] [--id <draftId>] [--file <spec.json>]
  draft update  --workspace <dir> --principal <id> --draft <draftId> --file <patch.json>
  draft show    --workspace <dir> --principal <id> --draft <draftId>
  draft list    --workspace <dir> --principal <id>
  inspect       --workspace <dir> --principal <id> --draft <draftId>
  help                  (also: --help, or no arguments)

Exit codes: 0 success, 2 invalid-invocation, 3 authority-denied, 1 any other typed error.
`;

const INIT_FLAGS = ["workspace", "principal", "json"] as const;
const DRAFT_CREATE_FLAGS = ["workspace", "principal", "json", "name", "description", "id", "file"] as const;
const DRAFT_UPDATE_FLAGS = ["workspace", "principal", "json", "draft", "file"] as const;
const DRAFT_SHOW_FLAGS = ["workspace", "principal", "json", "draft"] as const;
const DRAFT_LIST_FLAGS = ["workspace", "principal", "json"] as const;
const INSPECT_FLAGS = ["workspace", "principal", "json", "draft"] as const;

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

type VerbHandler = (args: ParsedArgs, context: CliContext, jsonMode: boolean) => CliResult;

const VERBS: ReadonlyMap<string, VerbHandler> = new Map([
  ["init", handleInit],
  ["draft create", handleDraftCreate],
  ["draft update", handleDraftUpdate],
  ["draft show", handleDraftShow],
  ["draft list", handleDraftList],
  ["inspect", handleInspect],
]);

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
 * argument parsing, flag validation, or the operations facade is caught
 * here and rendered as a typed envelope (or, outside `--json`, a plain-text
 * stderr line) with the matching exit code. Never touches `process`; that
 * is `bin.ts`'s job alone.
 */
export function runCli(argv: readonly string[], context: CliContext): CliResult {
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
    return handler(args, context, jsonMode);
  } catch (cause) {
    return renderThrown(cause, jsonMode);
  }
}
