/**
 * Unit tests for `operator/src/harnesses/cost-estimates.ts`.
 *
 * Acceptance criteria pulled from Issue #331 (cost protection P0):
 *   - MODEL_COST_TABLE lookup returns the heuristic per-task estimate.
 *   - decideCostSurface suppresses the cost surface for subscription
 *     billing paths (usesPaidApiKey false).
 *   - decideCostSurface requires the confirmation gate when estimate
 *     exceeds the default $1/task threshold (e.g. Opus 4.7).
 *   - decideCostSurface does NOT require the gate below threshold or for
 *     subscription paths (no false-positive gate fire).
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
} from '../../src/harnesses/cost-estimates.js';

describe('MODEL_COST_TABLE', () => {
  it('covers the canonical Anthropic, OpenAI, and OpenRouter ids the dashboard exposes', () => {
    // Spot-check the ids that ship in operator/src/dashboard/spa/src/pages/
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

describe('decideCostSurface — subscription billing path', () => {
  it('suppresses the estimate when usesPaidApiKey is false regardless of model', () => {
    const decision = decideCostSurface(false, 'claude-opus-4-7');
    expect(decision.showEstimate).toBe(false);
    expect(decision.requiresConfirmation).toBe(false);
    expect(decision.suppressedReason).toMatch(/subscription/i);
  });
});

describe('decideCostSurface — paid-API-key billing path', () => {
  it('shows estimate and gate for paid claude-code + Opus when usesPaidApiKey is true', () => {
    const decision = decideCostSurface(true, 'claude-opus-4-7');
    expect(decision.showEstimate).toBe(true);
    expect(decision.requiresConfirmation).toBe(true);
  });

  it('shows the estimate and triggers the gate for Hermes + Opus 4.7 ($2.25 > $1)', () => {
    const decision = decideCostSurface(true, 'anthropic/claude-opus-4.7');
    expect(decision.showEstimate).toBe(true);
    expect(decision.estimate).not.toBeNull();
    expect(decision.estimate!.usd).toBeGreaterThan(DEFAULT_HIGH_COST_THRESHOLD_USD);
    expect(decision.requiresConfirmation).toBe(true);
  });

  it('shows the estimate but does NOT trigger the gate for Hermes + DeepSeek V4 Flash (well under $1)', () => {
    const decision = decideCostSurface(true, 'deepseek/deepseek-v4-flash');
    expect(decision.showEstimate).toBe(true);
    expect(decision.estimate).not.toBeNull();
    expect(decision.estimate!.usd).toBeLessThan(DEFAULT_HIGH_COST_THRESHOLD_USD);
    expect(decision.requiresConfirmation).toBe(false);
  });

  it('shows the estimate slot but does NOT trigger the gate when the model is unknown', () => {
    const decision = decideCostSurface(true, 'unknown-vendor/custom-finetune');
    expect(decision.showEstimate).toBe(true);
    expect(decision.estimate).toBeNull();
    expect(decision.requiresConfirmation).toBe(false);
  });

  it('honours a caller-supplied threshold', () => {
    const decision = decideCostSurface(true, 'anthropic/claude-opus-4.7', 10);
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
