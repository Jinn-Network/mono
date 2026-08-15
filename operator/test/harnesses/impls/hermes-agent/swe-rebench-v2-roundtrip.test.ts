// operator/test/harnesses/impls/hermes-agent/swe-rebench-v2-roundtrip.test.ts
import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { SweRebenchV2SolutionPayloadSchema } from '@jinn-network/sdk/solvernets/swe-rebench-v2';
import { HermesHarness } from '../../../../src/harnesses/impls/hermes-agent/harness.js';
import { HermesHarnessAdapter } from '../../../../src/harnesses/impls/hermes-agent/adapter.js';
import type { HarnessContext } from '../../../../src/harnesses/types.js';
import type { Task } from '../../../../src/types/task.js';

const networkToolsRoot = fileURLToPath(new URL('../../../../plugins/network-tools/', import.meta.url));
const sweRuntimeRoot = fileURLToPath(new URL('../../../../plugins/swe-rebench-v2-runtime/', import.meta.url));

function fakeHermes(workingDir: string): EventEmitter & { stdout: EventEmitter; stderr: EventEmitter; killed: boolean; kill: any } {
  // Simulate Hermes: writes a valid solution payload to workingDir/.execute/solution-payload.json then exits 0
  const child = new EventEmitter() as any;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.killed = false;
  child.kill = vi.fn();
  setImmediate(() => {
    mkdirSync(join(workingDir, '.execute'), { recursive: true });
    writeFileSync(
      join(workingDir, '.execute/solution-payload.json'),
      JSON.stringify({ schemaVersion: 'swe-rebench-v2-solution.v1', patch: '--- a/file\n+++ b/file\n' }),
    );
    child.emit('exit', 0, null);
  });
  return child;
}

function sweTask(): Task {
  return {
    id: 'swe-rebench-task-1',
    description: 'swe-rebench-v2 restoration task',
    solverType: 'swe-rebench-v2.v1',
    role: 'restoration',
    window: { startTs: 0, endTs: Date.now() + 60_000 },
    spec: {
      schemaVersion: 'swe-rebench-v2.v1',
      instance_id: 'unidata__netcdf-c-1925',
      repo: 'Unidata/netcdf-c',
      base_commit: 'a'.repeat(40),
      language: 'c',
      problem_statement: 'fix the netcdf bug',
      interface: '',
      hf_dataset: 'nebius/SWE-rebench-leaderboard',
      hf_split: '2026_02',
      deadline_unix: Math.floor(Date.now() / 1000) + 3600,
      round_month: '2026-05',
    },
  } as unknown as Task;
}

describe('hermes-agent SWE-rebench v2 roundtrip', () => {
  it('produces a Solution conforming to the schema with stubbed Hermes', async () => {
    const home = mkdtempSync(join(tmpdir(), 'hermes-rt-home-'));
    const work = mkdtempSync(join(tmpdir(), 'hermes-rt-wd-'));
    try {
      const adapter = new HermesHarnessAdapter({
        hermesPath: '/bin/fake-hermes',
        operatorHermesHome: home,
        hermesModel: 'anthropic/claude-opus-4.6',
        hermesProvider: 'anthropic',
        daemonApiUrl: 'http://127.0.0.1:7331',
        daemonApiToken: 'tok',
        corpusEnv: {},
        _spawnFn: vi.fn(() => fakeHermes(work) as any) as any,
      });
      const harness = new HermesHarness({ adapter });

      const ctx = {
        task: sweTask(),
        requestId: '0x' + '7'.repeat(64),
        solverNet: { model: 'anthropic/claude-opus-4.6' },
        implStateDir: home,
        workingDir: work,
        solverPluginRoots: [networkToolsRoot, sweRuntimeRoot],
        mode: 'train' as const,
        abort: new AbortController().signal,
        msUntilEndTs: () => 60_000,
      } as unknown as HarnessContext;

      const solution = await harness.run(ctx);

      // Verify the Solution validates against the SDK schema
      const parsed = SweRebenchV2SolutionPayloadSchema.safeParse(solution.solutionPayload);
      expect(parsed.success).toBe(true);
      expect(solution.venueRef.name).toBe('hermes-agent');

      // Verify Hermes config was written
      const yaml = readFileSync(join(home, 'config.yaml'), 'utf8');
      expect(yaml).toContain('mcp_servers:');
      expect(yaml).toContain('platform_toolsets:');
      expect(yaml).toContain('skills:');
      expect(yaml).toContain('swe-rebench-v2-runtime/skills');
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(work, { recursive: true, force: true });
    }
  });
});
