import { describe, it, expect } from 'vitest';
import { serialiseRegistry } from '../../../src/restorer/plug-ins/serialise.js';
import { emptyRegistry } from '../../../src/restorer/plug-ins/registry.js';

describe('serialiseRegistry', () => {
  it('produces a JSON-serialisable shape with builtAt + learnerVersion', () => {
    const r = serialiseRegistry(emptyRegistry(), '0.1.0');
    const json = JSON.stringify(r);
    const parsed = JSON.parse(json);
    expect(parsed.learnerVersion).toBe('0.1.0');
    expect(typeof parsed.builtAt).toBe('string');
    expect(parsed.phaseAgentOverrides).toEqual([]);
  });

  it('strips RegistrySlot internals beyond plugInName / packageRoot / slot', () => {
    const reg = emptyRegistry();
    (reg.phaseAgentOverrides as unknown[]).push({
      plugInName: '@x/p',
      plugInVersion: '0.1.0',
      packageRoot: '/tmp/x',
      slot: {
        type: 'phase-agent-override',
        phase: 'execute',
        agent: 'step-worker',
        entry: 'a.md',
      },
    });
    const s = serialiseRegistry(reg, '0.1.0');
    const projected = s.phaseAgentOverrides[0] as Record<string, unknown>;
    expect(projected.plugInVersion).toBeUndefined();
    expect(projected.plugInName).toBe('@x/p');
    expect(projected.packageRoot).toBe('/tmp/x');
  });
});
