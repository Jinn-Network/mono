/**
 * RestorerImplRegistry — impl registration + operator-config-aware dispatch.
 *
 * §6.7 of spec/2026-04-17-portfolio-v0-design.md
 *
 * Dispatch priority:
 *   1. wrapWith — when set AND the named impl is registered, active, and
 *      supports() the requested ctx, the wrapper wins for non-evaluation
 *      kinds. This is the policy switch for the claude-code-learner
 *      universal-wrap behaviour (jinn-mono-0k2). Evaluations bypass the
 *      wrapper and dispatch normally.
 *   2. byKind[spec.kind] — explicit operator mapping wins regardless of
 *      registration order
 *   3. config.default — named fallback impl
 *   4. First-match — iterate registered impls, return first whose supports()
 *      returns true
 *
 * Disabled impls (config.disabled[]) are filtered out before dispatch.
 */

import type { RestorerImpl } from '../types.js';
import type { ImplRegistry } from './engine.js';

// ── Operator config schema ─────────────────────────────────────────────────────

export interface RestorerDispatchConfig {
  /**
   * Explicit kind → impl name mapping.
   * e.g. { "portfolio.v0": "claude-mcp-hyperliquid" }
   */
  byKind?: Record<string, string>;
  /**
   * Fallback impl name when no kind-specific match is found.
   */
  default?: string;
  /**
   * Impl names to exclude from dispatch entirely.
   */
  disabled?: string[];
  /**
   * Universal-wrap impl name (jinn-mono-0k2). When set AND the named impl is
   * registered + active + supports() the requested ctx, the registry returns
   * that impl for any non-evaluation dispatch — bypassing byKind / default /
   * first-match. Evaluations are dispatched normally.
   *
   * Default-on operator config sets `wrapWith: 'claude-code-learner'` so the
   * learning envelope wraps every restoration kind. Operators flip it off
   * (`wrapWith: null | undefined` or omit) to dispatch directly to
   * specialists for benchmarking / raw-impl behaviour. `null` is accepted so
   * the JinnConfig schema can encode "explicit opt-out" without losing the
   * key on serialise.
   */
  wrapWith?: string | null;
}

// ── RestorerImplRegistry ──────────────────────────────────────────────────────

export class RestorerImplRegistry implements ImplRegistry {
  private readonly impls: RestorerImpl[] = [];
  private readonly config: RestorerDispatchConfig;

  constructor(config: RestorerDispatchConfig = {}) {
    this.config = config;
  }

  /**
   * Register an impl. Later registrations appear later in the list for
   * first-match fallback dispatch.
   */
  register(impl: RestorerImpl): void {
    this.impls.push(impl);
  }

  /**
   * Find the impl to use for the given spec kind, applying operator config
   * dispatch rules.
   *
   * Returns undefined if no suitable impl is found (all disabled, none
   * support the kind, or registry is empty).
   */
  findFor(ctx: { kind: string; type?: 'restoration' | 'evaluation' }): RestorerImpl | undefined {
    const disabled = new Set(this.config.disabled ?? []);
    const active = this.impls.filter((impl) => !disabled.has(impl.name));

    // 0. wrapWith universal-wrap policy (jinn-mono-0k2) — only for non-evaluation
    //    dispatches. Evaluations bypass the wrapper so verdict envelopes route
    //    directly to the specialist evaluator impl.
    if (this.config.wrapWith && ctx.type !== 'evaluation') {
      const wrapper = active.find((impl) => impl.name === this.config.wrapWith);
      if (wrapper && wrapper.supports(ctx)) return wrapper;
    }

    // 1. byKind explicit mapping — but ONLY honor it if the named impl supports
    //    the requested ctx. Otherwise fall through (e.g., byKind points at the
    //    restorer impl, but ctx asks for an evaluation).
    const kindName = this.config.byKind?.[ctx.kind];
    if (kindName) {
      const named = active.find((impl) => impl.name === kindName);
      if (named && named.supports(ctx)) return named;
    }

    // 2. default fallback name
    if (this.config.default) {
      const defaultImpl = active.find((impl) => impl.name === this.config.default);
      if (defaultImpl && defaultImpl.supports(ctx)) {
        return defaultImpl;
      }
    }

    // 3. First-match by supports()
    return active.find((impl) => impl.supports(ctx));
  }

  /** All registered impls (including disabled ones). */
  list(): RestorerImpl[] {
    return [...this.impls];
  }
}
