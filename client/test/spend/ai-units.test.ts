/**
 * AI-units calibration + projection.
 *
 * Issue #815: a single "AI unit" is defined by a peg to the
 * GPT-5.4-mini Codex-Plus 6h-block-equivalent USD cost. 100 AI units = 10%
 * of that baseline. The per-block ceiling for *any* harness/model is 100
 * units; harnesses convert their USD cost-per-task to AI units through the
 * peg.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  GPT_5_4_MINI_USD_PER_BLOCK,
  REFERENCE_CEILING,
  projectAiUnits,
  resolveReferenceCeiling,
} from '../../src/spend/ai-units.js';

describe('AI-units calibration', () => {
  it('REFERENCE_CEILING.units_per_block is 100', () => {
    expect(REFERENCE_CEILING.units_per_block).toBe(100);
  });

  it('REFERENCE_CEILING.units_per_week is 28 * units_per_block (28 blocks/week)', () => {
    // 7 days * 4 blocks per day = 28; weekly cap is the natural multiple.
    expect(REFERENCE_CEILING.units_per_week).toBe(28 * REFERENCE_CEILING.units_per_block);
  });

  it('GPT_5_4_MINI_USD_PER_BLOCK is a positive number (the AI-unit peg)', () => {
    expect(typeof GPT_5_4_MINI_USD_PER_BLOCK).toBe('number');
    expect(GPT_5_4_MINI_USD_PER_BLOCK).toBeGreaterThan(0);
  });
});

describe('projectAiUnits', () => {
  it('returns null when the paid harness has an unpriceable model', () => {
    expect(projectAiUnits('hermes-agent', 'no-such-model-xyz')).toBeNull();
  });

  it('returns 0 for a non-LLM harness (no marginal call to cost)', () => {
    // prediction-v1-baseline does not call an LLM; project to 0.
    expect(projectAiUnits('prediction-v1-baseline', undefined)).toBe(0);
  });

  it('returns a positive AI-unit count for a paid-API harness + priced model', () => {
    const units = projectAiUnits('hermes-agent', 'claude-opus-4-7');
    expect(units).not.toBeNull();
    expect(units as number).toBeGreaterThan(0);
  });

  it('Opus 4.7 projects to substantially more units than Haiku 4.5', () => {
    const opus = projectAiUnits('hermes-agent', 'anthropic/claude-opus-4.7') ?? 0;
    const haiku = projectAiUnits('hermes-agent', 'claude-haiku-4-5-20251001') ?? 0;
    // Acceptance-criteria example says Opus ~50, Haiku ~1 — order-of-magnitude.
    expect(opus).toBeGreaterThan(haiku * 5);
  });

  it('converts USD through the peg: 1% of 6h-block USD => 1 AI unit (within rounding)', () => {
    // Construct a deterministic check: if estimateModelCost(model) -> X USD,
    // projectAiUnits(harness, model) should equal X / GPT_5_4_MINI_USD_PER_BLOCK * 100.
    const units = projectAiUnits('hermes-agent', 'gpt-5.4-mini');
    expect(units).not.toBeNull();
    // gpt-5.4-mini @ 50k input + 20k output = 0.0125 + 0.04 = 0.0525 USD.
    const expected = (0.0525 / GPT_5_4_MINI_USD_PER_BLOCK) * 100;
    expect(units as number).toBeCloseTo(expected, 4);
  });

  it('claude-code / codex project to 0 when the credential is subscription-typed', () => {
    expect(projectAiUnits('claude-code', 'claude-opus-4-7', 'anthropic:subscription')).toBe(0);
    expect(projectAiUnits('codex', 'gpt-5.3-codex', 'openai:subscription')).toBe(0);
  });

  it('claude-code / codex project to 0 when no credential is resolved (no provider key set)', () => {
    expect(projectAiUnits('claude-code', 'claude-opus-4-7')).toBe(0);
    expect(projectAiUnits('codex', 'gpt-5.3-codex')).toBe(0);
  });

  it('claude-code projects model cost when the credential is api-key (paid)', () => {
    // claude-haiku-4-5-20251001 @ 50k input + 20k output = 0.05 + 0.10 = 0.15 USD.
    const units = projectAiUnits(
      'claude-code',
      'claude-haiku-4-5-20251001',
      'anthropic:api-key',
    );
    expect(units).not.toBeNull();
    const expected = (0.15 / GPT_5_4_MINI_USD_PER_BLOCK) * 100;
    expect(units as number).toBeCloseTo(expected, 4);
  });

  it('codex projects model cost when the credential is api-key (paid)', () => {
    const units = projectAiUnits('codex', 'gpt-5.4-mini', 'openai:api-key');
    expect(units).not.toBeNull();
    expect(units as number).toBeGreaterThan(0);
  });
});

describe('resolveReferenceCeiling (env override)', () => {
  it('returns the baked-in REFERENCE_CEILING when JINN_AI_UNITS_CEILING_OVERRIDE is unset', () => {
    expect(resolveReferenceCeiling({})).toEqual(REFERENCE_CEILING);
  });

  it('parses an integer override as the new per-block cap, weekly scales proportionally', () => {
    const out = resolveReferenceCeiling({ JINN_AI_UNITS_CEILING_OVERRIDE: '10' });
    expect(out.units_per_block).toBe(10);
    expect(out.units_per_week).toBe(10 * 28);
  });

  it('parses block:week JSON syntax for explicit week override', () => {
    const out = resolveReferenceCeiling({ JINN_AI_UNITS_CEILING_OVERRIDE: '5:100' });
    expect(out.units_per_block).toBe(5);
    expect(out.units_per_week).toBe(100);
  });

  it('falls back to the baked-in ceiling on a malformed override', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      expect(resolveReferenceCeiling({ JINN_AI_UNITS_CEILING_OVERRIDE: 'garbage' })).toEqual(REFERENCE_CEILING);
    } finally {
      warn.mockRestore();
    }
  });

  it('warns when JINN_AI_UNITS_CEILING_OVERRIDE is set but unparseable (operator typo)', () => {
    // Per Stage-6 security review (low-2): a malformed override must not
    // silently fall back to default — the operator's typo would be invisible
    // in logs. Each of these inputs is "set but unparseable" and should
    // produce a console.warn before returning REFERENCE_CEILING.
    for (const raw of ['abc', '5:', '-10', '0', '5:bad']) {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      try {
        const out = resolveReferenceCeiling({ JINN_AI_UNITS_CEILING_OVERRIDE: raw });
        expect(out).toEqual(REFERENCE_CEILING);
        expect(warn).toHaveBeenCalledTimes(1);
        const [msg] = warn.mock.calls[0] as [string];
        expect(msg).toContain('JINN_AI_UNITS_CEILING_OVERRIDE');
        expect(msg).toContain(raw);
        expect(msg).toContain('malformed');
      } finally {
        warn.mockRestore();
      }
    }
  });

  it('does NOT warn when override is unset or empty', () => {
    for (const env of [{}, { JINN_AI_UNITS_CEILING_OVERRIDE: '' }, { JINN_AI_UNITS_CEILING_OVERRIDE: '   ' }]) {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      try {
        resolveReferenceCeiling(env);
        expect(warn).not.toHaveBeenCalled();
      } finally {
        warn.mockRestore();
      }
    }
  });

  it('does NOT warn on a valid override', () => {
    for (const raw of ['10', '5:100']) {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      try {
        resolveReferenceCeiling({ JINN_AI_UNITS_CEILING_OVERRIDE: raw });
        expect(warn).not.toHaveBeenCalled();
      } finally {
        warn.mockRestore();
      }
    }
  });
});
