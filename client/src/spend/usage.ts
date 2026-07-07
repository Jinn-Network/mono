import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CLAUDE_CODE_HARNESS, CODEX_HARNESS, canonicalHarnessName } from '../harnesses/names.js';
import { estimateModelCost } from '../harnesses/cost-estimates.js';
import { priceTokens } from './pricing.js';

/** USD attributed to a task whose model has no known price. */
export const UNKNOWN_MODEL_FALLBACK_USD = 1.0;

export interface HarnessUsage {
  model: string;
  costUsd: number;
  /** true = derived from an a-priori heuristic; false = from observed usage. */
  estimated: boolean;
  inputTokens?: number;
  outputTokens?: number;
}

/** Reject non-finite (NaN/Infinity) or negative numbers from harness-reported usage. */
function isValidNonNeg(x: number): boolean {
  return Number.isFinite(x) && x >= 0;
}

/**
 * Validate an optional Claude token-count field: accept finite non-negative
 * numbers, drop everything else to `undefined` (token counts are telemetry only).
 */
function validTokenField(value: unknown, field: string): number | undefined {
  if (typeof value !== 'number') return undefined;
  if (!isValidNonNeg(value)) {
    console.warn(`[spend] invalid ${field} from harness (value: ${value}) — field dropped`);
    return undefined;
  }
  return value;
}

/** Parse Claude Code `--output-format stream-json` output for the terminal result. */
export function parseClaudeCodeUsage(
  stdoutJsonl: string,
): { costUsd: number; inputTokens?: number; outputTokens?: number } | null {
  let result: { costUsd: number; inputTokens?: number; outputTokens?: number } | null = null;
  for (const line of stdoutJsonl.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let obj: Record<string, unknown>;
    try { obj = JSON.parse(trimmed); } catch { continue; }
    if (obj['type'] === 'result' && typeof obj['total_cost_usd'] === 'number') {
      const cost = obj['total_cost_usd'] as number;
      // total_cost_usd is gate-critical: a non-finite/negative value would poison
      // the spend accumulator. Reject the whole line so we fall back to the heuristic.
      if (!isValidNonNeg(cost)) {
        console.warn(`[spend] invalid total_cost_usd from harness (value: ${cost}) — falling back to heuristic`);
        continue;
      }
      const usage = obj['usage'] as Record<string, unknown> | undefined;
      // Token counts are optional telemetry (they do NOT drive Claude cost):
      // drop just the offending field rather than rejecting the cost.
      result = {
        costUsd: cost,
        inputTokens: validTokenField(usage?.['input_tokens'], 'input_tokens'),
        outputTokens: validTokenField(usage?.['output_tokens'], 'output_tokens'),
      };
    }
  }
  return result;
}

/** Parse Codex `--json` output for the last turn.completed token usage. */
export function parseCodexUsage(
  stdoutJsonl: string,
): { inputTokens: number; outputTokens: number } | null {
  let result: { inputTokens: number; outputTokens: number } | null = null;
  for (const line of stdoutJsonl.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let obj: Record<string, unknown>;
    try { obj = JSON.parse(trimmed); } catch { continue; }
    if (obj['type'] === 'turn.completed' && obj['usage']) {
      const usage = obj['usage'] as Record<string, unknown>;
      const inT = usage['input_tokens'];
      const outT = usage['output_tokens'];
      if (typeof inT === 'number' && typeof outT === 'number') {
        // Codex token counts ARE the cost basis (priced via priceTokens), so a
        // non-finite/negative count must reject the whole line and fall back.
        if (!isValidNonNeg(inT)) {
          console.warn(`[spend] invalid input_tokens from harness (value: ${inT}) — falling back to heuristic`);
          continue;
        }
        if (!isValidNonNeg(outT)) {
          console.warn(`[spend] invalid output_tokens from harness (value: ${outT}) — falling back to heuristic`);
          continue;
        }
        result = { inputTokens: inT, outputTokens: outT };
      }
    }
  }
  return result;
}

function heuristicUsage(model: string | undefined): HarnessUsage {
  const est = model ? estimateModelCost(model) : null;
  return {
    model: model ?? 'unknown',
    costUsd: est?.usd ?? UNKNOWN_MODEL_FALLBACK_USD,
    estimated: true,
  };
}

/**
 * Determine the USD cost of a finished harness run. Reads the harness's own
 * output file for observed usage; falls back to a heuristic on any failure.
 * Always returns a HarnessUsage — never throws.
 */
export function harvestHarnessUsage(
  harness: string,
  workingDir: string,
  model: string | undefined,
): HarnessUsage {
  try {
    const canonical = canonicalHarnessName(harness);
    if (canonical === CLAUDE_CODE_HARNESS) {
      const raw = readFileSync(join(workingDir, '.claude-code', 'stdout.jsonl'), 'utf8');
      const parsed = parseClaudeCodeUsage(raw);
      if (parsed) {
        return {
          model: model ?? 'unknown',
          costUsd: parsed.costUsd,
          estimated: false,
          inputTokens: parsed.inputTokens,
          outputTokens: parsed.outputTokens,
        };
      }
      return heuristicUsage(model);
    }
    if (canonical === CODEX_HARNESS) {
      const raw = readFileSync(join(workingDir, '.codex-code', 'stdout.jsonl'), 'utf8');
      const parsed = parseCodexUsage(raw);
      // When there is no model id, parsed token counts cannot be priced —
      // discard them and fall back to the heuristic (per spec).
      if (parsed && model) {
        const usd = priceTokens(model, parsed);
        if (usd != null) {
          return {
            model,
            costUsd: usd,
            estimated: false,
            inputTokens: parsed.inputTokens,
            outputTokens: parsed.outputTokens,
          };
        }
      }
      return heuristicUsage(model);
    }
    return heuristicUsage(model);
  } catch {
    return heuristicUsage(model);
  }
}
