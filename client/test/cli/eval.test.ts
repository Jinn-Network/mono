import { describe, expect, it, vi } from 'vitest';
import { createEvalCommand, corpusEnvFromConfig, resolveLocalImplStateDir, type EvalCommandDeps } from '@/cli/commands/eval.js';
import type { loadConfig } from '@/config.js';
import { makeCommandCtx } from '@test/cli.js';
import type { HarnessCheckpointManifest } from '@jinn-network/sdk/checkpoint';
import type { EvalRunResult } from '@/eval/orchestrator.js';

const manifest = { parentCheckpointCid: 'cid-parent', implStateDirCid: 'impl', codeDigest: 'sha256:x' } as unknown as HarnessCheckpointManifest;

const result: EvalRunResult = {
  perTask: [
    { instance_id: 'a-1', passed: true, unscorable: false },
    { instance_id: 'b-2', passed: false, unscorable: false },
  ],
  comparison: {
    child: { p: 0.8, lo: 0.49, hi: 0.94 },
    parent: { p: 0.5, lo: 0.24, hi: 0.76 },
    delta: 0.3,
    verdict: 'within-noise',
  },
  evaluated: {
    implStateDir: '/root/impl-state/claude-code-learner',
    codeDigest: 'sha256:abc',
    matchedCheckpoint: true,
  },
};

function baseDeps(over: Partial<EvalCommandDeps> = {}): EvalCommandDeps {
  return {
    fetchManifest: vi.fn(async () => manifest),
    runPipeline: vi.fn(async () => result),
    ...over,
  };
}

describe('jinn eval CLI', () => {
  it('resolves the manifest and runs the pipeline, emitting JSON with perTask + comparison', async () => {
    const deps = baseDeps();
    const cmd = createEvalCommand(deps);
    const { ctx, writes } = makeCommandCtx({
      argv: ['v1', '--checkpoint', 'cid-child', '--json'],
    });
    await cmd.run(ctx);

    expect(deps.fetchManifest).toHaveBeenCalledWith('cid-child');
    const out = JSON.parse(writes.join('').trim());
    expect(out.perTask).toEqual(result.perTask);
    expect(out.comparison.delta).toBeCloseTo(0.3, 5);
    expect(out.comparison.verdict).toBe('within-noise');
    // provenance is an additive field surfacing the locally-graded impl-state.
    expect(out.evaluated).toEqual(result.evaluated);
  });

  it('defaults the parent from manifest.parentCheckpointCid', async () => {
    const deps = baseDeps();
    const cmd = createEvalCommand(deps);
    const { ctx } = makeCommandCtx({ argv: ['v1', '--checkpoint', 'cid-child', '--json'] });
    await cmd.run(ctx);
    expect(deps.runPipeline).toHaveBeenCalledWith(
      expect.objectContaining({ parentCheckpointCid: 'cid-parent', checkpointCid: 'cid-child', slateVersion: 'v1' }),
    );
  });

  it('--parent overrides the manifest parent', async () => {
    const deps = baseDeps();
    const cmd = createEvalCommand(deps);
    const { ctx } = makeCommandCtx({
      argv: ['v1', '--checkpoint', 'cid-child', '--parent', 'cid-other', '--json'],
    });
    await cmd.run(ctx);
    expect(deps.runPipeline).toHaveBeenCalledWith(
      expect.objectContaining({ parentCheckpointCid: 'cid-other' }),
    );
  });

  it('renders a human-readable line in --human mode', async () => {
    const deps = baseDeps();
    const cmd = createEvalCommand(deps);
    const { ctx, writes } = makeCommandCtx({
      argv: ['v1', '--checkpoint', 'cid-child', '--human'],
    });
    await cmd.run(ctx);
    const text = writes.join('');
    expect(text).toContain('80.0%');
    expect(text).toContain('50.0%');
    expect(text).toMatch(/within noise|within-noise/);
    // provenance line: graded artifact is the local impl-state, verified == checkpoint.
    expect(text).toContain('evaluated local impl-state at sha256:abc, verified == checkpoint');
  });

  it('errors when --checkpoint is missing', async () => {
    const deps = baseDeps();
    const cmd = createEvalCommand(deps);
    const { ctx, exits } = makeCommandCtx({ argv: ['v1', '--json'] });
    await cmd.run(ctx);
    expect(exits.length).toBeGreaterThan(0);
    expect(deps.runPipeline).not.toHaveBeenCalled();
  });

  it('exposes name "eval"', () => {
    expect(createEvalCommand(baseDeps()).name).toBe('eval');
  });
});

// The per-task working-dir cleanup + the daemon-faithful HarnessContext
// (solverPluginRoots, corpusEnv) now live in the shared
// `runHarnessForEval` helper — see test/eval/eval-harness-run.test.ts.

describe('resolveLocalImplStateDir implName guard (security)', () => {
  const config = { engine: { implStateDirRoot: '/root/impl-state' } } as unknown as ReturnType<
    typeof loadConfig
  >;

  it('rejects a traversal implName from the manifest before the path join', () => {
    expect(() => resolveLocalImplStateDir(undefined, '../../..', config)).toThrow(/invalid harness implName/);
  });

  it('allows a well-formed implName', () => {
    expect(resolveLocalImplStateDir(undefined, 'claude-code-learner', config)).toBe(
      '/root/impl-state/claude-code-learner',
    );
  });

  it('honors an explicit --impl-state-dir without the implName check', () => {
    expect(resolveLocalImplStateDir('/some/explicit/dir', '../../..', config)).toBe('/some/explicit/dir');
  });
});

describe('corpusEnvFromConfig (daemon-faithful agent runtime)', () => {
  it('mirrors the daemon corpusEnv from config (discovery url, gateway, rpc, chainId, registry)', () => {
    const config = {
      network: 'testnet',
      discovery: { url: 'https://indexer.example' },
      ipfsGatewayUrl: 'https://gateway.example',
      rpcUrl: 'https://rpc.example',
      identityRegistryAddress: '0xRegistry',
    } as unknown as ReturnType<typeof loadConfig>;
    const env = corpusEnvFromConfig(config);
    expect(env).toEqual({
      discoveryUrl: 'https://indexer.example',
      ipfsGatewayUrl: 'https://gateway.example',
      rpcUrl: 'https://rpc.example',
      chainId: 84532,
      identityRegistryAddress: '0xRegistry',
      fromBlock: 41_100_000,
    });
  });

  it('returns undefined when neither discovery url nor registry is configured', () => {
    const config = {
      network: 'testnet',
      ipfsGatewayUrl: 'https://gateway.example',
      rpcUrl: 'https://rpc.example',
    } as unknown as ReturnType<typeof loadConfig>;
    expect(corpusEnvFromConfig(config)).toBeUndefined();
  });
});
