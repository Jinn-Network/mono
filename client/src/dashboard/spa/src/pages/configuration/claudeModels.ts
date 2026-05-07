/**
 * Canonical Claude model tiers exposed to operators in the SPA's SolverNet
 * configuration. The dropdown in `NetCard` shows these by friendly label;
 * the underlying `model` config field still stores the pinned id string.
 *
 * Operators with non-default pins (e.g. an older snapshot, or an id we
 * haven't surfaced yet) keep their stored value via the `Custom (<id>)`
 * fallback option — see `resolveModelOption`. The power-user escape hatch
 * remains the file-level `~/.jinn-client/config.json` model field.
 */

export interface ClaudeModelOption {
  /** Friendly tier label shown in the dropdown. */
  label: string;
  /** Pinned model id persisted to config. */
  id: string;
}

export const CLAUDE_MODELS: readonly ClaudeModelOption[] = [
  { label: 'Haiku', id: 'claude-haiku-4-5-20251001' },
  { label: 'Sonnet', id: 'claude-sonnet-4-6' },
  { label: 'Opus', id: 'claude-opus-4-7' },
] as const;

export interface ResolvedModelOption {
  /** Canonical option if `id` matches one of `CLAUDE_MODELS`, else `null`. */
  canonical: ClaudeModelOption | null;
  /** Display label — friendly tier or `Custom (<id>)` fallback. */
  label: string;
  /** Whether the id is outside the canonical set. */
  isCustom: boolean;
}

export function resolveModelOption(id: string): ResolvedModelOption {
  const canonical = CLAUDE_MODELS.find((m) => m.id === id) ?? null;
  if (canonical) {
    return { canonical, label: canonical.label, isCustom: false };
  }
  return { canonical: null, label: `Custom (${id})`, isCustom: true };
}
