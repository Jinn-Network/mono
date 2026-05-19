/**
 * Unit tests for `client/src/harnesses/cost-estimates.ts`.
 *
 * Acceptance criteria pulled from Issue #331 (cost protection P0):
 *   - MODEL_COST_TABLE lookup returns the heuristic per-task estimate.
 *   - decideCostSurface suppresses the cost surface for subscription
 *     harnesses (Claude Code, Codex).
 *   - decideCostSurface requires the confirmation gate when estimate
 *     exceeds the default $1/task threshold (e.g. Opus 4.7).
 *   - decideCostSurface does NOT require the gate below threshold or for
 *     subscription harnesses (no false-positive gate fire).
 *   - Heuristic value for Opus 4.7 on SWE-rebench-v2 typical task lands
 *     near $2.25 (the figure called out in the issue body).
 */

import { describe, it, expect } from 'vitest';
import {
  DEFAULT_HIGH_COST_THRESHOLD_USD,
  MODEL_COST_TABLE,
  decideCostSurface,
  estimateModelCost,
  formatUsd,
  harnessUsesPaidApiKey,
} from '../../src/harnesses/cost-estimates.js';

describe('MODEL_COST_TABLE', () => {
  it('covers the canonical Anthropic, OpenAI, and OpenRouter ids the dashboard exposes', () => {
    // Spot-check the ids that ship in client/src/dashboard/spa/src/pages/
    // configuration/claudeModels.ts — at minimum the operator default
    // (Haiku), the warning-tier (Opus 4.7), the OpenRouter route of the
    // same Opus family that Hermes lists, and the GPT-5.4 family.
    expect(MODEL_COST_TABLE['claude-haiku-4-5-20251001']).toBeDefined();
    expect(MODEL_COST_TABLE['claude-sonnet-4-6']).toBeDefined();
    expect(MODEL_COST_TABLE['claude-opus-4-7']).toBeDefined();
    expect(MODEL_COST_TABLE['anthropic/claude-opus-4.7']).toBeDefined();
    expect(MODEL_COST_TABLE['gpt-5.4']).toBeDefined();
    expect(MODEL_COST_TABLE['gpt-5.4-mini']).toBeDefined();
  });

  it('keeps the Opus 4.7 entry shape conservative — $0.015/1k input, $0.075/1k output', () => {
    const opus = MODEL_COST_TABLE['claude-opus-4-7']!;
    expect(opus.provider).toBe('anthropic');
    expect(opus.inputPer1kTokens).toBeCloseTo(0.015, 5);
    expect(opus.outputPer1kTokens).toBeCloseTo(0.075, 5);
  });
});

describe('estimateModelCost', () => {
  it('returns null for unknown model ids (callers render "estimate unavailable")', () => {
    expect(estimateModelCost('not-a-real-model-id')).toBeNull();
  });

  it('matches the Issue #331 heuristic: Opus 4.7 ≈ $2.25/task at 50k input + 20k output', () => {
    const estimate = estimateModelCost('claude-opus-4-7');
    expect(estimate).not.toBeNull();
    // 50k input × $0.015/1k + 20k output × $0.075/1k = $0.75 + $1.50 = $2.25
    expect(estimate!.usd).toBeCloseTo(2.25, 5);
    expect(estimate!.inputUsd).toBeCloseTo(0.75, 5);
    expect(estimate!.outputUsd).toBeCloseTo(1.5, 5);
  });

  it('produces a sub-$1 estimate for Haiku — does not trigger the high-cost band', () => {
    const estimate = estimateModelCost('claude-haiku-4-5-20251001');
    expect(estimate).not.toBeNull();
    expect(estimate!.usd).toBeLessThan(DEFAULT_HIGH_COST_THRESHOLD_USD);
  });

  it('produces a sub-$1 estimate for GPT-5.4 Mini', () => {
    const estimate = estimateModelCost('gpt-5.4-mini');
    expect(estimate).not.toBeNull();
    expect(estimate!.usd).toBeLessThan(DEFAULT_HIGH_COST_THRESHOLD_USD);
  });
});

describe('harnessUsesPaidApiKey', () => {
  it('returns false for subscription harnesses (Claude Code, Codex)', () => {
    expect(harnessUsesPaidApiKey('claude-code')).toBe(false);
    expect(harnessUsesPaidApiKey('codex')).toBe(false);
  });

  it('returns true for Hermes (paid raw API key path)', () => {
    expect(harnessUsesPaidApiKey('hermes-agent')).toBe(true);
  });

  it('canonicalises learner-prefixed harness names before classification', () => {
    // `claude-code-learner` aliases to `claude-code` in canonicalHarnessName.
    expect(harnessUsesPaidApiKey('claude-code-learner')).toBe(false);
    expect(harnessUsesPaidApiKey('codex-code-learner')).toBe(false);
  });

  it('treats unknown harnesses conservatively as paid (so we never silently hide a cost surface)', () => {
    expect(harnessUsesPaidApiKey('some-future-harness')).toBe(true);
  });

  it('returns false for an undefined harness (nothing to show)', () => {
    expect(harnessUsesPaidApiKey(undefined)).toBe(false);
  });
});

describe('decideCostSurface — subscription harnesses', () => {
  it('suppresses the estimate for Claude Code regardless of model', () => {
    const decision = decideCostSurface('claude-code', 'claude-opus-4-7');
    expect(decision.showEstimate).toBe(false);
    expect(decision.requiresConfirmation).toBe(false);
    expect(decision.suppressedReason).toMatch(/subscription/i);
  });

  it('suppresses the estimate for Codex regardless of model', () => {
    const decision = decideCostSurface('codex', 'gpt-5.5');
    expect(decision.showEstimate).toBe(false);
    expect(decision.requiresConfirmation).toBe(false);
    expect(decision.suppressedReason).toMatch(/subscription/i);
  });

  it('does NOT trigger the confirmation gate for Claude Code + Opus 4.7 (false-positive guard)', () => {
    // This is the explicit non-false-positive test called out in the
    // PR scope: subscription harnesses must never demand the budget
    // confirmation, even when paired with what would otherwise be a
    // high-cost API-priced model.
    const decision = decideCostSurface('claude-code', 'claude-opus-4-7');
    expect(decision.requiresConfirmation).toBe(false);
  });
});

describe('decideCostSurface — paid-API-key harnesses', () => {
  it('shows the estimate and triggers the gate for Hermes + Opus 4.7 ($2.25 > $1)', () => {
    const decision = decideCostSurface('hermes-agent', 'anthropic/claude-opus-4.7');
    expect(decision.showEstimate).toBe(true);
    expect(decision.estimate).not.toBeNull();
    expect(decision.estimate!.usd).toBeGreaterThan(DEFAULT_HIGH_COST_THRESHOLD_USD);
    expect(decision.requiresConfirmation).toBe(true);
  });

  it('shows the estimate but does NOT trigger the gate for Hermes + DeepSeek V4 Flash (well under $1)', () => {
    const decision = decideCostSurface('hermes-agent', 'deepseek/deepseek-v4-flash');
    expect(decision.showEstimate).toBe(true);
    expect(decision.estimate).not.toBeNull();
    expect(decision.estimate!.usd).toBeLessThan(DEFAULT_HIGH_COST_THRESHOLD_USD);
    expect(decision.requiresConfirmation).toBe(false);
  });

  it('shows the estimate slot but does NOT trigger the gate when the model is unknown', () => {
    // Unknown model — caller will render "estimate unavailable" rather
    // than a number. We deliberately don't gate, to avoid blocking joins
    // on operator-pinned custom ids we haven't priced yet.
    const decision = decideCostSurface('hermes-agent', 'unknown-vendor/custom-finetune');
    expect(decision.showEstimate).toBe(true);
    expect(decision.estimate).toBeNull();
    expect(decision.requiresConfirmation).toBe(false);
  });

  it('honours a caller-supplied threshold', () => {
    // Bump the threshold so even Opus 4.7 no longer trips the gate.
    const decision = decideCostSurface('hermes-agent', 'anthropic/claude-opus-4.7', 10);
    expect(decision.showEstimate).toBe(true);
    expect(decision.requiresConfirmation).toBe(false);
  });
});

describe('formatUsd', () => {
  it('renders <$0.01 for tiny values', () => {
    expect(formatUsd(0.0001)).toBe('<$0.01');
  });

  it('renders cents for sub-$1 values', () => {
    expect(formatUsd(0.43)).toBe('$0.43');
  });

  it('renders two decimals for typical task costs', () => {
    expect(formatUsd(2.25)).toBe('$2.25');
  });

  it('handles zero cleanly', () => {
    expect(formatUsd(0)).toBe('$0');
  });

  it('handles non-finite values without crashing', () => {
    expect(formatUsd(Number.NaN)).toBe('—');
  });
});
