import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { loadPlugIns } from '../../../src/restorer/plug-ins/loader.js';

function fakePkg(name: string, slots: unknown[]): string {
  const dir = mkdtempSync(join(tmpdir(), 'jinn-load-'));
  writeFileSync(
    join(dir, 'package.json'),
    JSON.stringify({ name, version: '0.1.0' }),
  );
  writeFileSync(
    join(dir, 'jinn-plugin.json'),
    JSON.stringify({
      schemaVersion: '1.0.0',
      name,
      version: '0.1.0',
      compatibility: { claudeCodeLearner: '>=0.1.0' },
      slots,
    }),
  );
  for (const slot of slots as Array<Record<string, unknown>>) {
    if (typeof slot.entry === 'string') {
      const abs = join(dir, slot.entry);
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, '---\nname: stub\n---\n# stub');
    }
    if (typeof slot.skillsDir === 'string') {
      mkdirSync(join(dir, slot.skillsDir), { recursive: true });
    }
  }
  return dir;
}

describe('loadPlugIns', () => {
  it('builds a registry with one phase-agent override', async () => {
    const pkg = fakePkg('@x/p', [
      {
        type: 'phase-agent-override',
        phase: 'execute',
        agent: 'step-worker',
        entry: 'agents/x.md',
        scope: { matchKinds: ['prediction.v0'] },
      },
    ]);
    const r = await loadPlugIns({
      entries: [{ name: '@x/p', entry: pkg }],
      learnerVersion: '0.1.0',
    });
    expect(r.errors).toEqual([]);
    expect(r.registry.phaseAgentOverrides).toHaveLength(1);
    expect(r.registry.phaseAgentOverrides[0].slot.phase).toBe('execute');
    expect(r.registry.phaseAgentOverrides[0].slot.agent).toBe('step-worker');
    expect(r.registry.phaseAgentOverrides[0].plugInName).toBe('@x/p');
  });

  it('first-installed-wins: collision drops second plug-in and records error', async () => {
    const pA = fakePkg('@x/a', [
      {
        type: 'phase-agent-override',
        phase: 'execute',
        agent: 'step-worker',
        entry: 'agents/a.md',
      },
    ]);
    const pB = fakePkg('@x/b', [
      {
        type: 'phase-agent-override',
        phase: 'execute',
        agent: 'step-worker',
        entry: 'agents/b.md',
      },
    ]);
    const r = await loadPlugIns({
      entries: [
        { name: '@x/a', entry: pA },
        { name: '@x/b', entry: pB },
      ],
      learnerVersion: '0.1.0',
    });
    // The collision is an error, not a warning: the second plug-in is dropped.
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0].plugInName).toBe('@x/b');
    expect(r.errors[0].reason).toMatch(/collision/i);
    // Only the first plug-in's slot is registered.
    expect(r.registry.phaseAgentOverrides).toHaveLength(1);
    expect(r.registry.phaseAgentOverrides[0].plugInName).toBe('@x/a');
    // No spurious warnings about the collision.
    expect(r.warnings.every((w) => !/collision/i.test(w))).toBe(true);
  });

  it('records load errors but continues with other plug-ins', async () => {
    const good = fakePkg('@x/good', [
      { type: 'mcp-tool', command: 'node', args: ['server.js'] },
    ]);
    const r = await loadPlugIns({
      entries: [
        { name: '@x/good', entry: good },
        { name: '@x/bad', entry: '/nonexistent/path/foo' },
      ],
      learnerVersion: '0.1.0',
    });
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0].plugInName).toBe('@x/bad');
    expect(r.registry.mcpTools).toHaveLength(1);
  });

  it('warns on out-of-range compatibility but loads anyway', async () => {
    const pkg = fakePkg('@x/p', [
      { type: 'mcp-tool', command: 'node', args: [] },
    ]);
    // Override the manifest to declare incompatible learner version.
    writeFileSync(
      join(pkg, 'jinn-plugin.json'),
      JSON.stringify({
        schemaVersion: '1.0.0',
        name: '@x/p',
        version: '0.1.0',
        compatibility: { claudeCodeLearner: '>=99.0.0' },
        slots: [{ type: 'mcp-tool', command: 'node', args: [] }],
      }),
    );
    const r = await loadPlugIns({
      entries: [{ name: '@x/p', entry: pkg }],
      learnerVersion: '0.1.0',
    });
    expect(r.warnings.some((w) => /compatibility|out-of-range/i.test(w))).toBe(
      true,
    );
    expect(r.registry.mcpTools).toHaveLength(1);
  });
});
