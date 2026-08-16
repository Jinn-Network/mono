/**
 * Generator-model provenance harvest + distribution-class derivation (#1827).
 *
 * Mirrors the read-the-harness's-own-output pattern in `spend/usage.ts`
 * (`harvestHarnessUsage`): try the harness transcript first, degrade to a
 * config-sourced fallback on any failure. Never throws — a missing or
 * unparseable transcript must never fail the solve.
 *
 * `source` on the returned GeneratorModel IS the honesty flag (spec
 * §8.2 delta 3): 'stream' means the model id was read from the harness's
 * own transcript (verifiable); 'config' means it fell back to the
 * SolverNet/daemon-configured model string (unverified, but not fabricated).
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CLAUDE_CODE_HARNESS, canonicalHarnessName } from '../names.js';
import type { GeneratorModel, DistributionClass } from '../../types/envelope.js';

/** Best-effort provider inference from a model id string. Returns undefined when unrecognized. */
function inferProvider(modelId: string | undefined): string | undefined {
  if (!modelId) return undefined;
  if (/^claude-/i.test(modelId)) return 'anthropic';
  if (/^(gpt-|o[0-9]|codex)/i.test(modelId)) return 'openai';
  return undefined;
}

/**
 * Parse claude-code `--output-format stream-json` output for model provenance.
 *
 * The log is append-only across retries and recovered runs. Track the last
 * relevant system/init or assistant model inside each run, and commit it only
 * when that run emits a terminal result. This prevents a stale first run (or
 * an incomplete trailing retry) from being attributed to the final completed
 * session.
 */
function harvestClaudeCodeStreamModel(workingDir: string): string | undefined {
  const raw = readFileSync(join(workingDir, '.claude-code', 'stdout.jsonl'), 'utf8');
  let activeModel: string | undefined;
  let completedModel: string | null | undefined;
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let obj: Record<string, unknown>;
    try {
      obj = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (obj['type'] === 'system' && obj['subtype'] === 'init') {
      const model = obj['model'];
      activeModel = typeof model === 'string' && model.length > 0
        ? model
        : undefined;
    }
    if (obj['type'] === 'assistant') {
      const message = obj['message'] as Record<string, unknown> | undefined;
      const model = message?.['model'];
      if (typeof model === 'string' && model.length > 0) activeModel = model;
    }
    if (obj['type'] === 'result') {
      completedModel = activeModel ?? null;
      activeModel = undefined;
    }
  }
  return completedModel !== undefined
    ? completedModel ?? undefined
    : activeModel;
}

/**
 * Determine the generator model that produced a harness run.
 *
 * Reads the harness's own transcript when a harvester is known for that
 * harness (currently: claude-code). Any read/parse failure, or a harness
 * with no known harvester (codex, hermes, prediction-only harnesses),
 * falls back to `configModel` with `source: 'config'` — never throws.
 */
export function harvestGeneratorModel(
  harness: string,
  workingDir: string,
  configModel: string | undefined,
): GeneratorModel {
  const canonical = canonicalHarnessName(harness);
  if (canonical === CLAUDE_CODE_HARNESS) {
    try {
      const streamed = harvestClaudeCodeStreamModel(workingDir);
      if (streamed) {
        return { id: streamed, provider: inferProvider(streamed) ?? 'anthropic', source: 'stream' };
      }
    } catch {
      // Degrade to config fallback below — never fail the solve on a
      // missing/unreadable transcript.
    }
  }
  const id = configModel ?? 'unknown';
  const provider = inferProvider(configModel);
  return provider ? { id, provider, source: 'config' } : { id, source: 'config' };
}

/**
 * Derive the distribution/licensing class of a generator model (#1827, §8.4).
 *
 * Conservative by construction: only positively-known restrictive-ToS
 * providers (Anthropic, OpenAI) resolve to 'restricted-tos'; everything
 * else — including a model with `openWeights: true` but no corroborating
 * license signal — resolves to 'unknown'. Nothing ever resolves to 'open'
 * today because no source in this codebase yet supplies the permissive
 * repo-license signal §8.4 requires alongside a positive open-weights
 * determination. Consumers MUST treat 'unknown' as 'restricted-tos', never
 * the reverse.
 */
export function deriveDistributionClass(generatorModel: GeneratorModel | undefined): DistributionClass {
  if (!generatorModel) return 'unknown';
  const provider = generatorModel.provider ?? inferProvider(generatorModel.id);
  if (provider === 'anthropic' || provider === 'openai') return 'restricted-tos';
  return 'unknown';
}
