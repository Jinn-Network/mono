/**
 * Wiring intent module.
 *
 * Per the intent-module law (DR-2026-08-05 decision-3 / headless design §4.1): a CLI verb is a
 * thin front-end over a PURE intent module — config in, structured result out. No
 * `CommandContext`, no argv, no writer/exit. The `jinn wiring` CLI verb
 * (`cli/commands/wiring.ts`) is one front-end; a future read-plane HTTP twin would be another.
 *
 * Read-only: it reports config shape v2's `executionWiring[]` (stage 1) and `posting[]` (the
 * one-swap M5 posting config). The only impurity is `generatedAt`.
 */
import type {
  ExecutionWiringConfigEntry,
  PostingConfigEntry,
} from '../config/shape-v2.js';

export interface WiringIntentInput {
  readonly executionWiring: readonly ExecutionWiringConfigEntry[];
  readonly posting: readonly PostingConfigEntry[];
}

export interface WiringListResult {
  readonly schemaVersion: 1;
  readonly generatedAt: string;
  readonly verb: 'wiring list';
  readonly entries: readonly ExecutionWiringConfigEntry[];
}

export interface WiringShowResult {
  readonly schemaVersion: 1;
  readonly generatedAt: string;
  readonly verb: 'wiring show';
  readonly found: true;
  readonly entry: ExecutionWiringConfigEntry;
}

export interface WiringShowNotFound {
  readonly found: false;
  readonly workKind: string;
}

export interface WiringPostingResult {
  readonly schemaVersion: 1;
  readonly generatedAt: string;
  readonly verb: 'wiring posting';
  readonly posting: readonly PostingConfigEntry[];
}

export function listWiringIntent(input: WiringIntentInput): WiringListResult {
  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    verb: 'wiring list',
    entries: input.executionWiring,
  };
}

/**
 * Resolves one execution-wiring entry by work kind. Returns a discriminated result — the CLI
 * front-end maps `found: false` onto an `invalid_invocation` envelope; the intent itself never
 * touches an exit code or a writer.
 */
export function showWiringIntent(
  input: WiringIntentInput,
  workKind: string,
): WiringShowResult | WiringShowNotFound {
  const entry = input.executionWiring.find((candidate) => candidate.workKind === workKind);
  if (entry === undefined) {
    return { found: false, workKind };
  }
  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    verb: 'wiring show',
    found: true,
    entry,
  };
}

export function postingWiringIntent(input: WiringIntentInput): WiringPostingResult {
  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    verb: 'wiring posting',
    posting: input.posting,
  };
}
