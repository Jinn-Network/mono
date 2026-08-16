/**
 * HarnessRegistry — Harness registration + SolverNet-aware dispatch.
 *
 * §6.7 of spec/2026-04-17-portfolio-v0-design.md
 *
 * Dispatch priority:
 *   0. ctx.harnessName — manifest-pinned Harness resolved by the caller from
 *      a specific joined SolverNet (by manifestCid, issue #2039). This is an
 *      exact binding: missing, disabled, or unsupported returns undefined.
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
/**
 * Resolves a `Harness` for a given solverType (and optional role), or returns
 * `undefined` when nothing is registered/enabled.
 *
 * Declared here since Wave-4 D1 retired `engine.ts`, which used to own it:
 * `HarnessRegistry` below is the only implementation and the only consumer.
 */
export interface ImplRegistry {
  findFor(ctx: {
    solverType: string;
    role?: 'restoration' | 'evaluation';
    /**
     * Manifest-pinned Harness name (issue #2039). Takes priority over any
     * boot-time static solverType→Harness map. Optional: callers without a
     * task-specific Harness in hand omit it and dispatch proceeds as before.
     */
    harnessName?: string;
  }): Harness | undefined;
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
  findFor(ctx: { solverType: string; role?: 'restoration' | 'evaluation'; harnessName?: string }): Harness | undefined {
    const disabled = canonicalHarnessNameSet(this.config.disabled ?? []);
    const active = this.harnesses.filter((harness) => !disabled.has(canonicalHarnessName(harness.name)));

    // 0. Manifest-pinned Harness — the caller resolved a specific joined
    //    SolverNet for this task (by manifestCid, issue #2039) and is
    //    telling us which Harness that net is configured to use. This takes
    //    priority over the boot-time static solverType map so two joined
    //    SolverNets sharing a solverType but configured with different
    //    Harnesses don't collide on whichever one the static map happens to
    //    name.
    if (ctx.harnessName) {
      const pinned = active.find((harness) => harnessNameMatches(harness.name, ctx.harnessName!));
      if (pinned && pinned.supports(ctx)) return pinned;
      return undefined;
    }

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
