/**
 * Canonical learner model tiers exposed to operators in the SPA's SolverNet
 * configuration. The dropdown shows these by friendly label; the underlying
 * `model` config field still stores the pinned id string.
 *
 * Operators with non-default pins (e.g. an older snapshot, or an id we
 * haven't surfaced yet) keep their stored value via the `Custom (<id>)`
 * fallback option — see `resolveModelOption`. The option set is keyed by
 * Harness because Claude Code and Codex use different model families.
 */
import { canonicalHarnessName, CODEX_HARNESS } from './harnessNames.js';

export interface LearnerModelOption {
  /** Friendly tier label shown in the dropdown. */
  label: string;
  /** Pinned model id persisted to config. */
  id: string;
}

export const CLAUDE_MODELS: readonly LearnerModelOption[] = [
  { label: 'Haiku', id: 'claude-haiku-4-5-20251001' },
  { label: 'Sonnet', id: 'claude-sonnet-4-6' },
  { label: 'Opus', id: 'claude-opus-4-7' },
] as const;

export const CODEX_MODELS: readonly LearnerModelOption[] = [
  { label: 'GPT-5.4 Mini', id: 'gpt-5.4-mini' },
  { label: 'GPT-5.5', id: 'gpt-5.5' },
  { label: 'GPT-5.4', id: 'gpt-5.4' },
  { label: 'GPT-5.3 Codex', id: 'gpt-5.3-codex' },
  { label: 'GPT-5.3 Codex Spark', id: 'gpt-5.3-codex-spark' },
] as const;

function isCodexHarness(harness: string | undefined): boolean {
  return canonicalHarnessName(harness) === CODEX_HARNESS;
}

export function modelOptionsForHarness(harness: string | undefined): readonly LearnerModelOption[] {
  return isCodexHarness(harness) ? CODEX_MODELS : CLAUDE_MODELS;
}

export function defaultModelForHarness(harness: string | undefined): string {
  return modelOptionsForHarness(harness)[0]!.id;
}

export interface ResolvedModelOption {
  /** Canonical option if `id` matches a known option, else `null`. */
  canonical: LearnerModelOption | null;
  /** Display label — friendly tier or `Custom (<id>)` fallback. */
  label: string;
  /** Whether the id is outside the canonical set. */
  isCustom: boolean;
}

export function resolveModelOption(id: string, harness?: string): ResolvedModelOption {
  const local = modelOptionsForHarness(harness).find((m) => m.id === id) ?? null;
  const canonical = local
    ?? CLAUDE_MODELS.find((m) => m.id === id)
    ?? CODEX_MODELS.find((m) => m.id === id)
    ?? null;
  if (canonical) {
    return { canonical, label: canonical.label, isCustom: false };
  }
  return { canonical: null, label: `Custom (${id})`, isCustom: true };
}
