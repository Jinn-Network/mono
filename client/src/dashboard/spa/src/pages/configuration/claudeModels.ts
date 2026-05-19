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
import { canonicalHarnessName, CODEX_HARNESS, HERMES_AGENT_HARNESS } from './harnessNames.js';

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

// Hermes routes models through providers (Nous Portal, OpenRouter, …) using
// `<provider>/<model>` ids. The first entry is the dashboard default.
// Operators wanting a different provider/model can pick from this list or
// override via `hermes model` (which the adapter inherits when the join
// config leaves `model` unset).
//
// Set sized + ordered for v0: Anthropic flagships first (operator default;
// historically Hermes's own recommended default), then the OpenRouter
// programming leaderboard top-10 (token-volume, verified live via
// /api/v1/models 2026-05-18 — see jinn-mono-u34i thread), then Nous's own
// Hermes-405B for harness-namesake continuity. Operators pinned to an id
// outside this list (e.g. `anthropic/claude-opus-4.6` from an older config)
// still work — `resolveModelOption` surfaces them as `Custom (<id>)`.
export const HERMES_MODELS: readonly LearnerModelOption[] = [
  { label: 'Claude Opus 4.7 (OpenRouter)',   id: 'anthropic/claude-opus-4.7'    },
  { label: 'Claude Sonnet 4.6 (OpenRouter)', id: 'anthropic/claude-sonnet-4.6'  },
  { label: 'Hy3 Preview',                    id: 'tencent/hy3-preview'          },
  { label: 'DeepSeek V4 Pro',                id: 'deepseek/deepseek-v4-pro'     },
  { label: 'DeepSeek V4 Flash',              id: 'deepseek/deepseek-v4-flash'   },
  { label: 'Gemini 3.1 Flash Lite',          id: 'google/gemini-3.1-flash-lite' },
  { label: 'Kimi K2.6',                      id: 'moonshotai/kimi-k2.6'         },
  { label: 'Owl Alpha',                      id: 'openrouter/owl-alpha'         },
  { label: 'MiniMax M2.7',                   id: 'minimax/minimax-m2.7'         },
  { label: 'Hermes 4 405B (Nous)',           id: 'nousresearch/hermes-4-405b'   },
] as const;

function isCodexHarness(harness: string | undefined): boolean {
  return canonicalHarnessName(harness) === CODEX_HARNESS;
}

function isHermesHarness(harness: string | undefined): boolean {
  return canonicalHarnessName(harness) === HERMES_AGENT_HARNESS;
}

export function modelOptionsForHarness(harness: string | undefined): readonly LearnerModelOption[] {
  if (isHermesHarness(harness)) return HERMES_MODELS;
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
    ?? HERMES_MODELS.find((m) => m.id === id)
    ?? null;
  if (canonical) {
    return { canonical, label: canonical.label, isCustom: false };
  }
  return { canonical: null, label: `Custom (${id})`, isCustom: true };
}
