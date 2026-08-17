import { describe, expect, it, vi } from 'vitest';
import { writeClaimPolicyIntent } from '../../src/intents/claim-policy-write.js';
import { writeExecutionWiringIntent } from '../../src/intents/execution-wiring-write.js';
import { restartDaemonIntent } from '../../src/intents/restart.js';

describe('writeClaimPolicyIntent', () => {
  it('persists the policy and notifies restart-required', () => {
    const persist = vi.fn(() => '/tmp/config.json');
    const notify = vi.fn();
    const result = writeClaimPolicyIntent({
      claimPolicy: { mode: 'every-runnable', aiUnitCap: 3 },
      configPath: '/tmp/config.json',
      persist,
      notifyRestartRequired: notify,
    });
    expect(persist).toHaveBeenCalledWith(
      'claimPolicy',
      { mode: 'every-runnable', aiUnitCap: 3 },
      '/tmp/config.json',
    );
    expect(notify).toHaveBeenCalledOnce();
    expect(result.restartRequired).toBe(true);
    expect(result.verb).toBe('policy set');
  });
});

describe('writeExecutionWiringIntent', () => {
  it('persists the wiring array', () => {
    const persist = vi.fn(() => '/tmp/config.json');
    const wiring = [
      {
        workKind: 'repository-work',
        harness: 'claude-code',
        model: 'claude-haiku-4-5-20251001',
        plugins: [],
        credentialRef: 'default',
        isolationPolicy: 'worktree',
      },
    ];
    const result = writeExecutionWiringIntent({
      executionWiring: wiring,
      persist,
    });
    expect(persist).toHaveBeenCalledWith('executionWiring', wiring, undefined);
    expect(result.verb).toBe('wiring set');
  });
});

describe('restartDaemonIntent', () => {
  it('invokes the injected restart hook', () => {
    const requestRestart = vi.fn();
    const result = restartDaemonIntent({ requestRestart, forceRespawn: true });
    expect(requestRestart).toHaveBeenCalledWith({ forceRespawn: true });
    expect(result.scheduled).toBe(true);
  });
});
