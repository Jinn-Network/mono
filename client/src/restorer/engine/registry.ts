/**
 * RestorerImplRegistry — impl registration + operator-config-aware dispatch.
 *
 * §6.7 of spec/2026-04-17-portfolio-v0-design.md
 *
 * Dispatch priority:
 *   1. byKind[spec.kind] — explicit operator mapping wins regardless of
 *      registration order
 *   2. config.default — named fallback impl
 *   3. First-match — iterate registered impls, return first whose supports()
 *      returns true
 *
 * Disabled impls (config.disabled[]) are filtered out before dispatch.
 */

import type { RestorerImpl } from '../types.js';
import type { RestorerImplRegistry as IRestorerImplRegistry } from './engine.js';

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
}

// ── RestorerImplRegistry ──────────────────────────────────────────────────────

export class RestorerImplRegistry implements IRestorerImplRegistry {
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
  findFor(spec: { kind: string }): RestorerImpl | undefined {
    const disabled = new Set(this.config.disabled ?? []);
    const active = this.impls.filter((impl) => !disabled.has(impl.name));

    // 1. byKind explicit mapping
    const kindName = this.config.byKind?.[spec.kind];
    if (kindName) {
      return active.find((impl) => impl.name === kindName);
    }

    // 2. default fallback name
    if (this.config.default) {
      const defaultImpl = active.find((impl) => impl.name === this.config.default);
      if (defaultImpl && defaultImpl.supports(spec)) {
        return defaultImpl;
      }
    }

    // 3. First-match by supports()
    return active.find((impl) => impl.supports(spec));
  }

  /** All registered impls (including disabled ones). */
  list(): RestorerImpl[] {
    return [...this.impls];
  }

  /**
   * IRestorerImplRegistry compatibility: resolve an impl name for a given
   * spec kind, or null if none registered.
   */
  resolveImplName(specKind: string | null): string | null {
    if (specKind === null) return null;
    const impl = this.findFor({ kind: specKind });
    return impl?.name ?? null;
  }
}
