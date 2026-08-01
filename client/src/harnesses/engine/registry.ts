/**
 * HarnessRegistry — Harness registration + SolverNet-aware dispatch.
 *
 * §6.7 of spec/2026-04-17-portfolio-v0-design.md
 *
 * Dispatch priority:
 *   1. solverTypeHarnesses[task.solverType] — SolverNet-selected Harness
 *   2. config.default — named fallback impl
 *   3. First-match — iterate registered Harnesses, return first whose supports()
 *      returns true
 *
 * Disabled Harnesses (config.disabled[]) are filtered out before dispatch.
 */

import type { Harness } from '../types.js';
import {
  canonicalHarnessName,
  canonicalHarnessNameSet,
  CLAUDE_CODE_HARNESS,
  harnessNameMatches,
} from '../names.js';

/** Dispatch surface previously owned by TaskEngine; kept for HarnessRegistry consumers. */
export interface ImplRegistry {
  findFor(ctx: { solverType: string; role?: 'restoration' | 'evaluation' }): Harness | undefined;
}

// Harness dispatch defaults shared by the daemon and operator diagnostics.
export const DEFAULT_HARNESS = CLAUDE_CODE_HARNESS;
export const DEFAULT_DISABLED_HARNESSES = ['claude-mcp-hyperliquid'] as const;

// ── Operator config schema ─────────────────────────────────────────────────────

export interface HarnessDispatchConfig {
  /**
   * Explicit solverType → Harness name mapping.
   * e.g. { "portfolio.v0": "claude-mcp-hyperliquid" }
   */
  solverTypeHarnesses?: Record<string, string>;
  /**
   * Fallback Harness name when no solverType-specific match is found.
   */
  default?: string;
  /**
   * Harness names to exclude from dispatch entirely.
   */
  disabled?: string[];
}

// ── HarnessRegistry ──────────────────────────────────────────────────────

export class HarnessRegistry implements ImplRegistry {
  private readonly harnesses: Harness[] = [];
  private readonly config: HarnessDispatchConfig;

  constructor(config: HarnessDispatchConfig = {}) {
    this.config = config;
  }

  /**
   * Register a Harness. Later registrations appear later in the list for
   * first-match fallback dispatch.
   */
  register(harness: Harness): void {
    this.harnesses.push(harness);
  }

  /**
   * Find the Harness to use for the given solverType, applying operator config
   * dispatch rules.
   *
   * Returns undefined if no suitable impl is found (all disabled, none
   * support the kind, or registry is empty).
   */
  findFor(ctx: { solverType: string; role?: 'restoration' | 'evaluation' }): Harness | undefined {
    const disabled = canonicalHarnessNameSet(this.config.disabled ?? []);
    const active = this.harnesses.filter((harness) => !disabled.has(canonicalHarnessName(harness.name)));

    // 1. SolverNet-selected Harness — but ONLY honor it if the named Harness supports
    //    the requested ctx. Otherwise fall through (e.g., restoration Harness selected,
    //    but ctx asks for an evaluation).
    const harnessName = this.config.solverTypeHarnesses?.[ctx.solverType];
    if (harnessName) {
      const named = active.find((harness) => harnessNameMatches(harness.name, harnessName));
      if (named && named.supports(ctx)) return named;
    }

    // 2. default fallback name
    if (this.config.default) {
      const defaultHarness = active.find((harness) => harnessNameMatches(harness.name, this.config.default!));
      if (defaultHarness && defaultHarness.supports(ctx)) {
        return defaultHarness;
      }
    }

    // 3. First-match by supports()
    return active.find((harness) => harness.supports(ctx));
  }

  /** All registered Harnesses (including disabled ones). */
  list(): Harness[] {
    return [...this.harnesses];
  }
}
