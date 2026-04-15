/**
 * Unit Test: create_measurement ID Validation
 * Module: gemini-agent/mcp/tools/create_measurement.ts
 * Priority: P1 (HIGH)
 *
 * Tests that create_measurement warns when invariant_id doesn't match
 * known blueprint invariant IDs, while still creating the measurement.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('@jinn-network/mech-client-ts/dist/ipfs.js', () => ({
  pushJsonToIpfs: vi.fn().mockResolvedValue(['ipfs://Qm123', '0xabc123']),
}));

import { createMeasurement } from 'jinn-node/agent/mcp/tools/create_measurement.js';

describe('create_measurement ID validation', () => {
  const validArgs = {
    invariant_type: 'BOOLEAN',
    invariant_id: 'GOAL-CONTENT',
    passed: true,
    context: 'Content quality verified',
  };

  beforeEach(() => {
    delete process.env.JINN_BLUEPRINT_INVARIANT_IDS;
  });

  afterEach(() => {
    delete process.env.JINN_BLUEPRINT_INVARIANT_IDS;
  });

  it('succeeds without warnings when no blueprint IDs are set', async () => {
    const response = await createMeasurement(validArgs);
    const parsed = JSON.parse(response.content[0].text);

    expect(parsed.meta.ok).toBe(true);
    expect(parsed.data.invariant_id).toBe('GOAL-CONTENT');
    expect(parsed.data.warnings).toBeUndefined();
  });

  it('succeeds without warnings when invariant_id matches a known ID', async () => {
    process.env.JINN_BLUEPRINT_INVARIANT_IDS = JSON.stringify(['GOAL-CONTENT', 'GOAL-QUALITY']);

    const response = await createMeasurement(validArgs);
    const parsed = JSON.parse(response.content[0].text);

    expect(parsed.meta.ok).toBe(true);
    expect(parsed.data.invariant_id).toBe('GOAL-CONTENT');
    expect(parsed.data.warnings).toBeUndefined();
  });

  it('includes warning when invariant_id does not match any known ID', async () => {
    process.env.JINN_BLUEPRINT_INVARIANT_IDS = JSON.stringify(['GOAL-QUALITY', 'OUT-FORMAT']);

    const response = await createMeasurement(validArgs);
    const parsed = JSON.parse(response.content[0].text);

    expect(parsed.meta.ok).toBe(true);
    expect(parsed.data.invariant_id).toBe('GOAL-CONTENT');
    expect(parsed.data.passed).toBe(true);
    // Warning present but measurement still created
    expect(parsed.data.warnings).toHaveLength(1);
    expect(parsed.data.warnings[0]).toContain('GOAL-CONTENT');
    expect(parsed.data.warnings[0]).toContain('does not match');
    expect(parsed.data.warnings[0]).toContain('GOAL-QUALITY');
  });

  it('handles invalid JSON in env var gracefully (no warning)', async () => {
    process.env.JINN_BLUEPRINT_INVARIANT_IDS = 'not-json';

    const response = await createMeasurement(validArgs);
    const parsed = JSON.parse(response.content[0].text);

    expect(parsed.meta.ok).toBe(true);
    expect(parsed.data.warnings).toBeUndefined();
  });

  it('handles empty array in env var (no warning)', async () => {
    process.env.JINN_BLUEPRINT_INVARIANT_IDS = JSON.stringify([]);

    const response = await createMeasurement(validArgs);
    const parsed = JSON.parse(response.content[0].text);

    expect(parsed.meta.ok).toBe(true);
    expect(parsed.data.warnings).toBeUndefined();
  });

  it('validates FLOOR measurement type with unknown ID', async () => {
    process.env.JINN_BLUEPRINT_INVARIANT_IDS = JSON.stringify(['GOAL-A']);

    const response = await createMeasurement({
      invariant_type: 'FLOOR',
      invariant_id: 'GOAL-UNKNOWN',
      measured_value: 85,
      min_threshold: 70,
      context: 'Score check',
    });
    const parsed = JSON.parse(response.content[0].text);

    expect(parsed.meta.ok).toBe(true);
    expect(parsed.data.passed).toBe(true); // 85 >= 70
    expect(parsed.data.warnings).toHaveLength(1);
  });
});
