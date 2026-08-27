import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { chmodSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  checkWritableVolume,
  checkStateOnVolume,
  checkCredentialsResolvable,
  checkAgentCliNonRoot,
  runDeploymentReadinessChecks,
  isDeploymentContext,
  applyDeploymentReadinessGate,
  type DeploymentReadinessDeps,
} from '../../src/preflight/deployment-readiness.js';
import { detectAuthContext as realDetectAuthContext } from '../../src/preflight/claude-auth.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function baseDeps(overrides: Partial<DeploymentReadinessDeps> = {}): DeploymentReadinessDeps {
  return {
    env: {},
    getuid: () => 1000,
    detectAuthContext: () => 'bare',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// checkWritableVolume
// ---------------------------------------------------------------------------

describe('checkWritableVolume', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'jinn-deploy-vol-'));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it('ok against a writable tmp dir', async () => {
    const result = await checkWritableVolume(tmp);
    expect(result.name).toBe('writable_volume');
    expect(result.ok).toBe(true);
  });

  it('fails (structured) against a non-writable dir', async () => {
    if (typeof process.getuid === 'function' && process.getuid() === 0) {
      // root bypasses mode bits — the chmod assertion is unreliable.
      return;
    }
    chmodSync(tmp, 0o500);
    try {
      const result = await checkWritableVolume(tmp);
      expect(result.ok).toBe(false);
      expect(result.detail).toMatch(/not writable|EACCES|EROFS|ENOSPC/i);
    } finally {
      chmodSync(tmp, 0o700);
    }
  });

  it('does not throw when the target dir does not exist — returns a structured fail', async () => {
    const missing = join(tmp, 'does', 'not', 'exist');
    const result = await checkWritableVolume(missing);
    expect(result.ok).toBe(false);
    expect(result.name).toBe('writable_volume');
  });
});

// ---------------------------------------------------------------------------
// checkAgentCliNonRoot
// ---------------------------------------------------------------------------

describe('checkAgentCliNonRoot', () => {
  it('ok when injected uid is not 0', () => {
    const result = checkAgentCliNonRoot(() => 1000);
    expect(result.name).toBe('agent_cli_non_root');
    expect(result.ok).toBe(true);
  });

  it('fails when injected uid is 0 (root)', () => {
    const result = checkAgentCliNonRoot(() => 0);
    expect(result.ok).toBe(false);
    expect(result.detail).toMatch(/root/i);
  });

  it('ok when getuid is undefined (platform without uid, e.g. Windows)', () => {
    const result = checkAgentCliNonRoot(undefined);
    expect(result.ok).toBe(true);
  });

  it('never throws — a throwing getuid degrades to a structured result', () => {
    const result = checkAgentCliNonRoot((() => {
      throw new Error('boom');
    }) as unknown as () => number);
    expect(result.name).toBe('agent_cli_non_root');
    // A throwing probe must not crash; it degrades to a (conservative) result.
    expect(typeof result.ok).toBe('boolean');
  });
});

// ---------------------------------------------------------------------------
// checkCredentialsResolvable
// ---------------------------------------------------------------------------

describe('checkCredentialsResolvable', () => {
  it('ok in bare context (operator uses interactive claude session auth)', () => {
    const result = checkCredentialsResolvable({
      context: 'bare',
      env: {},
    });
    expect(result.name).toBe('credentials_resolvable');
    expect(result.ok).toBe(true);
  });

  it('ok in container context when an agent-CLI auth env var is present', () => {
    const result = checkCredentialsResolvable({
      context: 'container',
      env: { ANTHROPIC_API_KEY: 'sk-ant-xxxx', OPENROUTER_API_KEY: '' },
    });
    expect(result.ok).toBe(true);
  });

  it('fails in container context when no credential signal is present', () => {
    const result = checkCredentialsResolvable({
      context: 'container',
      env: {},
    });
    expect(result.ok).toBe(false);
  });

  it('never leaks the secret value into detail', () => {
    const secret = 'sk-ant-SUPERSECRET-DO-NOT-LEAK';
    const result = checkCredentialsResolvable({
      context: 'container',
      env: { ANTHROPIC_API_KEY: secret },
    });
    expect(result.detail).not.toContain(secret);
    expect(JSON.stringify(result)).not.toContain(secret);
  });
});

// ---------------------------------------------------------------------------
// checkStateOnVolume
// ---------------------------------------------------------------------------

describe('checkStateOnVolume', () => {
  it('ok outside a deployment context regardless of where state resolves (advisory)', () => {
    const result = checkStateOnVolume({
      deployment: false,
      stateDir: undefined,
      earningDir: '/Users/me/.jinn-client/earning',
    });
    expect(result.name).toBe('state_on_volume');
    expect(result.ok).toBe(true);
  });

  it('ok in a deployment context when stateDir is set and earningDir resolves under it', () => {
    const result = checkStateOnVolume({
      deployment: true,
      stateDir: '/data',
      earningDir: '/data/earning',
    });
    expect(result.ok).toBe(true);
  });

  it('fails in a deployment context when stateDir is unset (state on ephemeral default)', () => {
    const result = checkStateOnVolume({
      deployment: true,
      stateDir: undefined,
      earningDir: '/root/.jinn-client/earning',
    });
    expect(result.ok).toBe(false);
    expect(result.detail).toMatch(/volume|JINN_STATE_DIR|ephemeral/i);
  });

  it('fails in a deployment context when earningDir does not resolve under stateDir', () => {
    const result = checkStateOnVolume({
      deployment: true,
      stateDir: '/data',
      earningDir: '/somewhere/else/earning',
    });
    expect(result.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// isDeploymentContext
// ---------------------------------------------------------------------------

describe('isDeploymentContext', () => {
  it('true when JINN_STATE_DIR is set in env', () => {
    expect(isDeploymentContext({ env: { JINN_STATE_DIR: '/data' }, authContext: 'bare', stateDir: undefined })).toBe(
      true,
    );
  });

  it('true when config.stateDir is set even without the env var', () => {
    expect(isDeploymentContext({ env: {}, authContext: 'bare', stateDir: '/data' })).toBe(true);
  });

  it('true when auth context is container', () => {
    expect(isDeploymentContext({ env: {}, authContext: 'container', stateDir: undefined })).toBe(true);
  });

  it('true when auth context is docker-compose', () => {
    expect(isDeploymentContext({ env: {}, authContext: 'docker-compose', stateDir: undefined })).toBe(true);
  });

  it('false for a plain local operator (no JINN_STATE_DIR, bare context)', () => {
    expect(isDeploymentContext({ env: {}, authContext: 'bare', stateDir: undefined })).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// runDeploymentReadinessChecks (aggregate)
// ---------------------------------------------------------------------------

describe('runDeploymentReadinessChecks', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'jinn-deploy-agg-'));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it('returns one result per check and is not boot-fatal for a healthy local operator', async () => {
    const report = await runDeploymentReadinessChecks(
      { stateDir: undefined, earningDir: tmp, runtimeMode: undefined },
      baseDeps({ env: {}, getuid: () => 1000, detectAuthContext: () => 'bare' }),
    );
    expect(report.deployment).toBe(false);
    expect(report.bootFatal).toBe(false);
    const names = report.checks.map((c) => c.name).sort();
    expect(names).toEqual(
      [
        'agent_cli_non_root',
        'credentials_resolvable',
        'credentials_valid',
        'state_on_volume',
        'writable_volume',
      ].sort(),
    );
  });

  it('REGRESSION GUARD: local operator (no JINN_STATE_DIR) + unwritable volume is advisory, NOT boot-fatal', async () => {
    if (typeof process.getuid === 'function' && process.getuid() === 0) return; // root bypasses mode bits
    chmodSync(tmp, 0o500);
    try {
      const report = await runDeploymentReadinessChecks(
        { stateDir: undefined, earningDir: tmp, runtimeMode: undefined },
        baseDeps({ env: {}, getuid: () => 1000, detectAuthContext: () => 'bare' }),
      );
      const vol = report.checks.find((c) => c.name === 'writable_volume');
      expect(vol?.ok).toBe(false); // the check itself fails (surfaced in doctor)
      expect(report.deployment).toBe(false);
      expect(report.bootFatal).toBe(false); // but it MUST NOT gate a local boot
    } finally {
      chmodSync(tmp, 0o700);
    }
  });

  it('deployment context (JINN_STATE_DIR set) + unwritable volume IS boot-fatal', async () => {
    if (typeof process.getuid === 'function' && process.getuid() === 0) return; // root bypasses mode bits
    chmodSync(tmp, 0o500);
    try {
      const report = await runDeploymentReadinessChecks(
        { stateDir: tmp, earningDir: join(tmp, 'earning'), runtimeMode: undefined },
        baseDeps({ env: { JINN_STATE_DIR: tmp }, getuid: () => 1000, detectAuthContext: () => 'container' }),
      );
      expect(report.deployment).toBe(true);
      expect(report.bootFatal).toBe(true);
      const fatal = report.checks.find((c) => c.name === 'writable_volume');
      expect(fatal?.ok).toBe(false);
    } finally {
      chmodSync(tmp, 0o700);
    }
  });

  it('deployment context running as root IS boot-fatal', async () => {
    const report = await runDeploymentReadinessChecks(
      { stateDir: tmp, earningDir: join(tmp, 'earning'), runtimeMode: undefined },
      baseDeps({ env: { JINN_STATE_DIR: tmp }, getuid: () => 0, detectAuthContext: () => 'container' }),
    );
    expect(report.deployment).toBe(true);
    expect(report.bootFatal).toBe(true);
    expect(report.checks.find((c) => c.name === 'agent_cli_non_root')?.ok).toBe(false);
  });

  it('deployment context with state NOT on the volume IS boot-fatal', async () => {
    const report = await runDeploymentReadinessChecks(
      // env says deployment, but earningDir resolves to the ephemeral default — not under stateDir
      { stateDir: undefined, earningDir: '/root/.jinn-client/earning', runtimeMode: undefined },
      baseDeps({ env: { JINN_STATE_DIR: '/data' }, getuid: () => 1000, detectAuthContext: () => 'container' }),
    );
    expect(report.deployment).toBe(true);
    expect(report.bootFatal).toBe(true);
    expect(report.checks.find((c) => c.name === 'state_on_volume')?.ok).toBe(false);
  });

  it('config.runtimeMode docker-compose ARMS the gate with no env var / no /.dockerenv (threaded as configuredMode)', async () => {
    // No JINN_STATE_DIR, no JINN_RUNTIME_MODE, no stateDir, /.dockerenv absent —
    // the ONLY deployment signal is the persisted config.runtimeMode. Use the
    // real detectAuthContext so the configuredMode threading is exercised
    // end-to-end (with dockerenvExists pinned false for hermeticity).
    const report = await runDeploymentReadinessChecks(
      { stateDir: undefined, earningDir: tmp, runtimeMode: 'docker-compose' },
      baseDeps({
        env: {},
        getuid: () => 1000,
        detectAuthContext: (opts) => realDetectAuthContext({ ...opts, dockerenvExists: false }),
      }),
    );
    expect(report.authContext).toBe('docker-compose');
    expect(report.deployment).toBe(true); // gate armed via config.runtimeMode alone
  });

  it('REGRESSION GUARD: bare local operator with NO runtimeMode / no env / no stateDir stays deployment:false', async () => {
    // Same detection path as above (real detectAuthContext, /.dockerenv absent),
    // but runtimeMode is undefined — the gate must stay disarmed.
    const report = await runDeploymentReadinessChecks(
      { stateDir: undefined, earningDir: tmp, runtimeMode: undefined },
      baseDeps({
        env: {},
        getuid: () => 1000,
        detectAuthContext: (opts) => realDetectAuthContext({ ...opts, dockerenvExists: false }),
      }),
    );
    expect(report.authContext).toBe('bare');
    expect(report.deployment).toBe(false);
    expect(report.bootFatal).toBe(false);
  });

  it('does not throw even if a dependency throws — aggregate degrades to structured results', async () => {
    const report = await runDeploymentReadinessChecks(
      { stateDir: undefined, earningDir: tmp, runtimeMode: undefined },
      baseDeps({
        env: {},
        getuid: (() => {
          throw new Error('uid boom');
        }) as unknown as () => number,
        detectAuthContext: () => 'bare',
      }),
    );
    // It produced a report rather than throwing.
    expect(Array.isArray(report.checks)).toBe(true);
    expect(report.checks.length).toBeGreaterThan(0);
  });

  it('keeps presence and validity as separate checks in the aggregate', async () => {
    const secret = 'sk-ant-SUPERSECRET-DO-NOT-LEAK';
    const report = await runDeploymentReadinessChecks(
      {
        stateDir: tmp,
        earningDir: join(tmp, 'earning'),
        runtimeMode: undefined,
        executionWiring: [{ harness: 'claude-code' }],
      },
      baseDeps({
        env: { JINN_STATE_DIR: tmp, ANTHROPIC_API_KEY: secret },
        getuid: () => 1000,
        detectAuthContext: () => 'container',
        probeClaudeAuth: () => ({
          authenticated: false,
          context: 'container',
          detail: 'not logged in',
          validity: 'invalid',
        }),
      }),
    );
    const presence = report.checks.find((c) => c.name === 'credentials_resolvable');
    const validity = report.checks.find((c) => c.name === 'credentials_valid');
    expect(presence?.ok).toBe(true);
    expect(validity?.ok).toBe(false);
    expect(validity?.detail).toMatch(/claude: invalid/i);
    expect(JSON.stringify(report)).not.toContain(secret);
  });

  it('hosted invalid auth for a required runtime IS boot-fatal', async () => {
    const report = await runDeploymentReadinessChecks(
      {
        stateDir: tmp,
        earningDir: join(tmp, 'earning'),
        runtimeMode: undefined,
        executionWiring: [{ harness: 'claude-code' }],
      },
      baseDeps({
        env: { JINN_STATE_DIR: tmp, ANTHROPIC_API_KEY: 'sk-ant-xxxx' },
        getuid: () => 1000,
        detectAuthContext: () => 'container',
        probeClaudeAuth: () => ({
          authenticated: false,
          context: 'container',
          detail: 'not logged in',
          validity: 'invalid',
        }),
      }),
    );
    expect(report.deployment).toBe(true);
    expect(report.bootFatal).toBe(true);
    expect(report.checks.find((c) => c.name === 'credentials_valid')?.ok).toBe(false);
  });

  it('hosted probe timeout for a required runtime is advisory, not boot-fatal', async () => {
    // Scope note: the stubbed hang exercises the OUTER `withTimeout` race in
    // `probeRuntime`, not the hermes probe's own timeout. The real
    // `probeHermesAuthStatus` resolves rather than hanging, so this test does
    // not cover a missing or wedged hermes binary — the test below does.

    const report = await runDeploymentReadinessChecks(
      {
        stateDir: tmp,
        earningDir: join(tmp, 'earning'),
        runtimeMode: undefined,
        executionWiring: [{ harness: 'hermes-agent' }],
      },
      baseDeps({
        env: { JINN_STATE_DIR: tmp, OPENROUTER_API_KEY: 'or-xxxx' },
        getuid: () => 1000,
        detectAuthContext: () => 'container',
        validityTimeoutMs: 20,
        probeHermesAuthStatus: () => new Promise(() => undefined),
      }),
    );
    expect(report.deployment).toBe(true);
    expect(report.bootFatal).toBe(false);
    const validity = report.checks.find((c) => c.name === 'credentials_valid');
    expect(validity?.ok).toBe(true);
    expect(validity?.detail).toMatch(/hermes: error/i);
  });

  it('REGRESSION GUARD: a missing hermes binary is advisory, not boot-fatal', async () => {
    // The test above stubs a hang, so it exercises the outer `withTimeout`
    // race. The real `probeHermesAuthStatus` RESOLVES for a missing or wedged
    // binary, so that race never fires in production — this drives the real
    // return shape instead. Classifying it `invalid` would refuse the boot in
    // a hosted deployment and take the operator console (served by this same
    // daemon) down with it, turning a missing binary into a restart loop.
    const report = await runDeploymentReadinessChecks(
      {
        stateDir: tmp,
        earningDir: join(tmp, 'earning'),
        runtimeMode: undefined,
        executionWiring: [{ harness: 'hermes-agent' }],
      },
      baseDeps({
        env: { JINN_STATE_DIR: tmp, OPENROUTER_API_KEY: 'or-xxxx' },
        getuid: () => 1000,
        detectAuthContext: () => 'container',
        probeHermesAuthStatus: async () => ({
          provider: 'openrouter',
          authed: false,
          raw: '',
          errorCode: 'ENOENT',
        }),
      }),
    );
    expect(report.deployment).toBe(true);
    expect(report.bootFatal).toBe(false);
    const validity = report.checks.find((c) => c.name === 'credentials_valid');
    expect(validity?.ok).toBe(true);
    expect(validity?.detail).toMatch(/hermes: error \(ENOENT\)/);
  });

  it('REGRESSION GUARD: a hermes CLI that exits non-zero is advisory, not boot-fatal', async () => {
    // The guard above covers a binary that never spawned. This is the other
    // half: the binary is there, it runs, and it fails — no errno, empty
    // stdout, non-zero exit. The credential (`OPENROUTER_API_KEY`) is fine,
    // so refusing the boot would blame the operator for the wrong thing.
    const report = await runDeploymentReadinessChecks(
      {
        stateDir: tmp,
        earningDir: join(tmp, 'earning'),
        runtimeMode: undefined,
        executionWiring: [{ harness: 'hermes-agent' }],
      },
      baseDeps({
        env: { JINN_STATE_DIR: tmp, OPENROUTER_API_KEY: 'or-xxxx' },
        getuid: () => 1000,
        detectAuthContext: () => 'container',
        probeHermesAuthStatus: async () => ({
          provider: 'openrouter',
          authed: false,
          raw: '',
          exitCode: 1,
        }),
      }),
    );
    expect(report.deployment).toBe(true);
    expect(report.bootFatal).toBe(false);
    const validity = report.checks.find((c) => c.name === 'credentials_valid');
    expect(validity?.ok).toBe(true);
    expect(validity?.detail).toMatch(/hermes: error \(hermes CLI probe failed\)/);
    expect(JSON.stringify(report)).not.toContain('or-xxxx');
  });

  it('REGRESSION GUARD: bare-local invalid auth stays advisory, not boot-fatal', async () => {
    const report = await runDeploymentReadinessChecks(
      {
        stateDir: undefined,
        earningDir: tmp,
        runtimeMode: undefined,
        executionWiring: [{ harness: 'claude-code' }],
      },
      baseDeps({
        env: { ANTHROPIC_API_KEY: 'sk-ant-xxxx' },
        getuid: () => 1000,
        detectAuthContext: () => 'bare',
        probeClaudeAuth: () => ({
          authenticated: false,
          context: 'bare',
          detail: 'not logged in',
          validity: 'invalid',
        }),
      }),
    );
    expect(report.deployment).toBe(false);
    expect(report.bootFatal).toBe(false);
    expect(report.checks.find((c) => c.name === 'credentials_valid')?.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// applyDeploymentReadinessGate (boot gate, fail-loud only in deployment ctx)
// ---------------------------------------------------------------------------

describe('applyDeploymentReadinessGate', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'jinn-deploy-gate-'));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it('does NOT emit an envelope for a healthy local operator', async () => {
    const writes: string[] = [];
    const exits: number[] = [];
    await applyDeploymentReadinessGate(
      { stateDir: undefined, earningDir: tmp, runtimeMode: undefined },
      baseDeps({ env: {}, getuid: () => 1000, detectAuthContext: () => 'bare' }),
      { writer: { write: (s: string) => (writes.push(s), true) }, exit: (c: number) => void exits.push(c) },
    );
    expect(exits).toEqual([]);
    expect(writes).toEqual([]);
  });

  it('REGRESSION GUARD: does NOT gate a local operator even with an unwritable volume', async () => {
    if (typeof process.getuid === 'function' && process.getuid() === 0) return;
    chmodSync(tmp, 0o500);
    const exits: number[] = [];
    try {
      await applyDeploymentReadinessGate(
        { stateDir: undefined, earningDir: tmp, runtimeMode: undefined },
        baseDeps({ env: {}, getuid: () => 1000, detectAuthContext: () => 'bare' }),
        { writer: { write: () => true }, exit: (c: number) => void exits.push(c) },
      );
    } finally {
      chmodSync(tmp, 0o700);
    }
    expect(exits).toEqual([]); // advisory only — local boot proceeds
  });

  it('does NOT gate a bare-local operator with invalid required-runtime auth', async () => {
    const exits: number[] = [];
    await applyDeploymentReadinessGate(
      {
        stateDir: undefined,
        earningDir: tmp,
        runtimeMode: undefined,
        executionWiring: [{ harness: 'claude-code' }],
      },
      baseDeps({
        env: { ANTHROPIC_API_KEY: 'sk-ant-xxxx' },
        getuid: () => 1000,
        detectAuthContext: () => 'bare',
        probeClaudeAuth: () => ({
          authenticated: false,
          context: 'bare',
          detail: 'not logged in',
          validity: 'invalid',
        }),
      }),
      { writer: { write: () => true }, exit: (c: number) => void exits.push(c) },
    );
    expect(exits).toEqual([]);
  });

  it('emits a fail-loud envelope when hosted required-runtime auth is invalid', async () => {
    const writes: string[] = [];
    const exits: number[] = [];
    const secret = 'sk-ant-SUPERSECRET-DO-NOT-LEAK';
    await applyDeploymentReadinessGate(
      {
        stateDir: tmp,
        earningDir: join(tmp, 'earning'),
        runtimeMode: undefined,
        executionWiring: [{ harness: 'claude-code' }],
      },
      baseDeps({
        env: { JINN_STATE_DIR: tmp, ANTHROPIC_API_KEY: secret },
        getuid: () => 1000,
        detectAuthContext: () => 'container',
        probeClaudeAuth: () => ({
          authenticated: false,
          context: 'container',
          detail: 'not logged in',
          validity: 'invalid',
        }),
      }),
      { writer: { write: (s: string) => (writes.push(s), true) }, exit: (c: number) => void exits.push(c) },
    );
    expect(exits.length).toBe(1);
    expect(exits[0]).not.toBe(0);
    const envelope = JSON.parse(writes[0]!);
    expect(envelope.code).toBe('invalid_invocation');
    expect(JSON.stringify(envelope)).not.toContain(secret);
    expect(JSON.stringify(envelope)).toMatch(/credentials_valid|claude/i);
  });

  it('emits a fail-loud envelope (non-zero exit) in deployment context running as root', async () => {
    const writes: string[] = [];
    const exits: number[] = [];
    await applyDeploymentReadinessGate(
      { stateDir: tmp, earningDir: join(tmp, 'earning'), runtimeMode: undefined },
      baseDeps({ env: { JINN_STATE_DIR: tmp }, getuid: () => 0, detectAuthContext: () => 'container' }),
      { writer: { write: (s: string) => (writes.push(s), true) }, exit: (c: number) => void exits.push(c) },
    );
    expect(exits.length).toBe(1);
    expect(exits[0]).not.toBe(0);
    const envelope = JSON.parse(writes[0]!);
    expect(envelope.code).toBe('invalid_invocation');
    // No secret material in the envelope.
    expect(JSON.stringify(envelope)).not.toMatch(/sk-ant-/);
  });
});
