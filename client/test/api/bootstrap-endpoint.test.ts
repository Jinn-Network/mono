import { describe, it, expect } from 'vitest';
import { Hono } from 'hono';
import { addBootstrapRoutes } from '../../src/api/bootstrap-endpoint.js';
import { buildEnvelope } from '../../src/errors/envelope.js';
import { persistBootstrapError } from '../../src/errors/persisted-bootstrap-error.js';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function makeFixtureEarningDir(state: object): string {
  const dir = mkdtempSync(join(tmpdir(), 'jinn-bootstrap-'));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'earning_state.json'), JSON.stringify(state));
  return dir;
}

describe('GET /v1/bootstrap', () => {
  it('returns the current bootstrap step + per-step status when state file exists', async () => {
    const earningDir = makeFixtureEarningDir({
      master_address: '0xabc',
      chain: 'base-sepolia',
      services: [{ index: 0, step: 'awaiting_funding', safe_address: '0xsafe' }],
    });
    const app = new Hono();
    addBootstrapRoutes(app, { earningDir });
    const res = await app.request('/v1/bootstrap');
    expect(res.status).toBe(200);
    const body = await res.json() as { mode: string; currentStep: string; services: unknown[] };
    expect(body.mode).toBe('setup');
    expect(body.currentStep).toBe('awaiting_funding');
    expect(body.services).toHaveLength(1);
  });

  it('returns mode=running when all services are complete', async () => {
    const earningDir = makeFixtureEarningDir({
      master_address: '0xabc',
      chain: 'base-sepolia',
      services: [{ index: 0, step: 'complete', safe_address: '0xsafe' }],
    });
    const app = new Hono();
    addBootstrapRoutes(app, { earningDir });
    const res = await app.request('/v1/bootstrap');
    const body = await res.json() as { mode: string };
    expect(body.mode).toBe('running');
  });

  it('returns mode=running when a service is operational but identity binding is pending', async () => {
    const earningDir = makeFixtureEarningDir({
      master_address: '0xabc',
      chain: 'base-sepolia',
      services: [{ index: 0, step: 'safe_binding_pending', safe_address: '0xsafe' }],
    });
    const app = new Hono();
    addBootstrapRoutes(app, { earningDir });
    const res = await app.request('/v1/bootstrap');
    const body = await res.json() as { mode: string; currentStep: string };
    expect(body.mode).toBe('running');
    expect(body.currentStep).toBe('safe_binding_pending');
  });

  it('returns mode=uninitialized when no state file exists', async () => {
    const earningDir = mkdtempSync(join(tmpdir(), 'jinn-bootstrap-empty-'));
    const app = new Hono();
    addBootstrapRoutes(app, { earningDir });
    const res = await app.request('/v1/bootstrap');
    const body = await res.json() as { mode: string };
    expect(body.mode).toBe('uninitialized');
  });

  it('advances past awaiting_funding once master wallet exists with no persisted funding gate (jinn-mono-u34i)', async () => {
    // Pre-u34i this case returned 'awaiting_funding' even when no funding
    // gate file existed — leaving the panel on phase 2 ("Fund your wallet")
    // during the entire post-funding Stage 1 window (Safe deploy, agentId
    // mint, setAgentWallet bind), 30-60s of stale "still awaiting funds"
    // copy while the daemon was actively deploying contracts.
    //
    // The fix: when no funding-gate file is persisted and master_address is
    // set, currentStep advances to 'safe_deployed' — the first phase-3 step
    // in Onboarding.tsx's phase map ('Joining Jinn · Deploying'). The panel
    // transitions immediately, accurately reflecting the daemon's state.
    const earningDir = makeFixtureEarningDir({
      master_address: '0xabc',
      chain: 'base-sepolia',
      services: [],
    });
    const app = new Hono();
    addBootstrapRoutes(app, { earningDir });
    const res = await app.request('/v1/bootstrap');
    expect(res.status).toBe(200);
    const body = await res.json() as { mode: string; currentStep: string; services: unknown[] };
    expect(body.mode).toBe('setup');
    expect(body.currentStep).toBe('safe_deployed');
    expect(body.services).toHaveLength(0);
  });

  it('exposes funding balance/target on a fresh fleet (services=[]) so the SPA can render real progress', async () => {
    const earningDir = makeFixtureEarningDir({
      master_address: '0xabc',
      chain: 'base-sepolia',
      services: [],
    });
    writeFileSync(join(earningDir, 'bootstrap-funding.json'), JSON.stringify({
      schemaVersion: 1,
      master_address: '0xabc',
      eth_required: '10000000000000000',
      eth_balance: '0',
    }));
    const app = new Hono();
    addBootstrapRoutes(app, { earningDir });
    const res = await app.request('/v1/bootstrap');
    expect(res.status).toBe(200);
    const body = await res.json() as {
      mode: string;
      funding?: { eth_required?: string; eth_balance?: string; targetWei?: string };
    };
    expect(body.mode).toBe('setup');
    expect(body.funding).toMatchObject({
      eth_required: '10000000000000000',
      eth_balance: '0',
      targetWei: '10000000000000000',
    });
  });

  // Issue #2407: the endpoint's old 14-entry STEPS list dropped `awaiting_stake`,
  // so a service actually at `awaiting_stake` had no entry in STEP_INDEX and
  // was mis-reported as `currentStep: 'wallet'` (phase 1) instead of its real
  // position. The unified 15-entry FLEET_BOOTSTRAP_PHASES list fixes this.
  it('reports currentStep=awaiting_stake (not wallet) for a service at that step', async () => {
    const earningDir = makeFixtureEarningDir({
      master_address: '0xabc',
      chain: 'base-sepolia',
      services: [{ index: 1, step: 'awaiting_stake', safe_address: null }],
    });
    const app = new Hono();
    addBootstrapRoutes(app, { earningDir });
    const res = await app.request('/v1/bootstrap');
    expect(res.status).toBe(200);
    const body = await res.json() as { currentStep: string; steps: string[] };
    expect(body.currentStep).toBe('awaiting_stake');
    expect(body.steps).toContain('awaiting_stake');
    expect(body.steps).toHaveLength(15);
  });

  it('reports awaiting_funding when the daemon persists a funding gate during a partial bootstrap', async () => {
    const earningDir = makeFixtureEarningDir({
      master_address: '0xabc',
      chain: 'base-sepolia',
      services: [{ index: 1, step: 'staked', safe_address: '0xsafe' }],
    });
    writeFileSync(join(earningDir, 'bootstrap-funding.json'), JSON.stringify({
      schemaVersion: 1,
      master_address: '0xabc',
      eth_required: '1',
      eth_balance: '0',
    }));
    const app = new Hono();
    addBootstrapRoutes(app, { earningDir });
    const res = await app.request('/v1/bootstrap');
    expect(res.status).toBe(200);
    const body = await res.json() as {
      mode: string;
      currentStep: string;
      services: unknown[];
      funding?: { eth_required?: string; eth_balance?: string; targetWei?: string };
    };
    expect(body.mode).toBe('setup');
    expect(body.currentStep).toBe('awaiting_funding');
    expect(body.services).toHaveLength(1);
    expect(body.funding).toMatchObject({
      eth_required: '1',
      eth_balance: '0',
      targetWei: '1',
    });
  });

  it('surfaces persisted bootstrap-error.json envelope so the panel can render the failure', async () => {
    const earningDir = makeFixtureEarningDir({
      master_address: '0xabc',
      chain: 'base-sepolia',
      services: [],
    });
    const env = buildEnvelope({
      code: 'fatal',
      message: 'stOLAS stake() tx failed for service 1: 0xdeadbeef',
      hint: 'Bootstrap failed before the fleet reached a runnable state.',
      details: { cause: 'NoRewardsAvailable' },
    });
    persistBootstrapError(env, earningDir);

    const app = new Hono();
    addBootstrapRoutes(app, { earningDir });
    const res = await app.request('/v1/bootstrap');
    expect(res.status).toBe(200);
    const body = await res.json() as {
      error?: { code: string; message: string; exitCode: number; details?: unknown };
    };
    expect(body.error).toBeDefined();
    expect(body.error!.code).toBe('fatal');
    expect(body.error!.exitCode).toBe(50);
    expect(body.error!.message).toContain('stOLAS stake() tx failed');
    expect(body.error!.details).toEqual({ cause: 'NoRewardsAvailable' });
  });

  it('omits the error field when no bootstrap-error.json is present', async () => {
    const earningDir = makeFixtureEarningDir({
      master_address: '0xabc',
      chain: 'base-sepolia',
      services: [{ index: 0, step: 'complete', safe_address: '0xsafe' }],
    });
    const app = new Hono();
    addBootstrapRoutes(app, { earningDir });
    const res = await app.request('/v1/bootstrap');
    const body = await res.json() as { error?: unknown };
    expect(body.error).toBeUndefined();
  });

  it('includes rpcUrl, defaultRpcUrl, and executionWiring when configReader is supplied', async () => {
    const earningDir = makeFixtureEarningDir({
      master_address: '0xabc',
      chain: 'base-sepolia',
      services: [{ index: 1, step: 'complete' }],
    });
    const app = new Hono();
    const executionWiring = [{
      workKind: 'swe-rebench-v2.v1',
      harness: 'claude-code',
      model: 'claude-haiku-4-5-20251001',
      plugins: [],
      credentialRef: 'claude-code-default',
      isolationPolicy: 'process',
    }];
    addBootstrapRoutes(app, {
      earningDir,
      configReader: () => ({
        rpcUrl: 'https://my-tenderly.example/abc',
        defaultRpcUrl: 'https://sepolia.base.org',
        executionWiring,
      }),
    });
    const res = await app.request('/v1/bootstrap');
    expect(res.status).toBe(200);
    const body = await res.json() as {
      rpcUrl?: string;
      defaultRpcUrl?: string;
      solverNets?: Record<string, unknown>;
      joinedSolverNets?: Record<string, unknown>;
      executionWiring?: unknown[];
    };
    expect(body.rpcUrl).toBe('https://my-tenderly.example/abc');
    expect(body.defaultRpcUrl).toBe('https://sepolia.base.org');
    // Issue #421: the response no longer echoes a legacy `solverNets` field
    // even when configReader were to return one accidentally.
    expect(body.solverNets).toBeUndefined();
    expect(body.joinedSolverNets).toBeUndefined();
    expect(body.executionWiring).toEqual(executionWiring);
  });

  it('does not echo a `solverNets` field on /v1/bootstrap (issue #421)', async () => {
    const earningDir = makeFixtureEarningDir({
      master_address: '0xabc',
      chain: 'base-sepolia',
      services: [{ index: 1, step: 'complete' }],
    });
    const app = new Hono();
    addBootstrapRoutes(app, {
      earningDir,
      configReader: () => ({
        executionWiring: [],
      }),
    });
    const res = await app.request('/v1/bootstrap');
    const body = await res.json() as Record<string, unknown>;
    expect(body).not.toHaveProperty('solverNets');
    expect(body).toHaveProperty('executionWiring');
    expect(body.joinedSolverNets).toBeUndefined();
  });

  it('surfaces a retire_failed envelope when migration archive has a wipe_suppressed=true entry (jinn-mono-hjex.1)', async () => {
    const earningDir = makeFixtureEarningDir({
      master_address: '0xabc',
      chain: 'base-sepolia',
      services: [{ index: 1, step: 'complete', safe_address: '0xsafe', service_id: 42 }],
    });
    writeFileSync(
      join(earningDir, 'earning_migrations.json'),
      JSON.stringify({
        schemaVersion: 1,
        updated_at: new Date().toISOString(),
        entries: [
          {
            migration_id: 'm1',
            retire_status: 'failed',
            retire_error: 'distributor.unstakeAndWithdraw reverted with InsufficientStake',
            retire_tx_hash: '0x' + 'ab'.repeat(32),
            state_reset_at: null,
            wipe_suppressed: true,
          },
        ],
      }),
    );
    const app = new Hono();
    addBootstrapRoutes(app, { earningDir });
    const res = await app.request('/v1/bootstrap');
    const body = await res.json() as { retire_failed?: { retire_error: string; tx_hash: string | null } };
    expect(body.retire_failed).toBeDefined();
    expect(body.retire_failed!.retire_error).toContain('InsufficientStake');
    expect(body.retire_failed!.tx_hash).toBe('0x' + 'ab'.repeat(32));
  });

  it('does NOT surface a retire_failed envelope for pre-PR archive entries lacking wipe_suppressed (jinn-mono-hjex.1)', async () => {
    // Pre-PR entries had retire_status='failed' but state was actually wiped.
    // The legacy `!state_reset_at` filter would falsely surface these. The
    // `wipe_suppressed === true` filter must suppress them.
    const earningDir = makeFixtureEarningDir({
      master_address: '0xabc',
      chain: 'base-sepolia',
      services: [{ index: 1, step: 'complete', safe_address: '0xsafe', service_id: 42 }],
    });
    writeFileSync(
      join(earningDir, 'earning_migrations.json'),
      JSON.stringify({
        schemaVersion: 1,
        updated_at: new Date().toISOString(),
        entries: [
          // Three legacy shapes: undefined, null, and empty-string state_reset_at
          // — all WITHOUT wipe_suppressed. None should surface a retire_failed
          // envelope; the legacy `!state_reset_at` filter would have falsely
          // matched all three.
          {
            migration_id: 'legacy-undef',
            retire_status: 'failed',
            retire_error: 'legacy undefined reset',
            // state_reset_at intentionally omitted
          },
          {
            migration_id: 'legacy-null',
            retire_status: 'failed',
            retire_error: 'legacy null reset',
            state_reset_at: null,
          },
          {
            migration_id: 'legacy-empty',
            retire_status: 'failed',
            retire_error: 'legacy empty reset',
            state_reset_at: '',
          },
        ],
      }),
    );
    const app = new Hono();
    addBootstrapRoutes(app, { earningDir });
    const res = await app.request('/v1/bootstrap');
    const body = await res.json() as { retire_failed?: unknown };
    expect(body.retire_failed).toBeUndefined();
  });
});

// Issue #110: uninitialized branch should surface bootstrap-error.json and
// bootstrap-funding.json so the SPA can render actionable states even before
// earning_state.json exists (i.e. before the first daemon run completes).
describe('GET /v1/bootstrap — uninitialized branch surfaces persisted files (issue #110)', () => {
  it('uninitialized branch surfaces persisted bootstrap-error.json', async () => {
    // NO earning_state.json — this is the uninitialized branch.
    const earningDir = mkdtempSync(join(tmpdir(), 'jinn-bootstrap-uninit-error-'));
    const env = buildEnvelope({
      code: 'funding_required',
      message: 'EOA needs 0.01 ETH; have 0',
      hint: 'Fund the address shown above, then re-run jinn run.',
      details: { address: '0xWallet', requiredWei: '10000000000000000', haveWei: '0' },
    });
    persistBootstrapError(env, earningDir);

    const app = new Hono();
    addBootstrapRoutes(app, { earningDir });
    const res = await app.request('/v1/bootstrap');
    expect(res.status).toBe(200);
    const body = await res.json() as {
      mode: string;
      error?: { code: string; exitCode: number; message: string };
    };
    expect(body.mode).toBe('uninitialized');
    expect(body.error).toBeDefined();
    expect(body.error!.code).toBe('funding_required');
    expect(body.error!.exitCode).toBe(10);
    expect(body.error!.message).toContain('EOA needs 0.01 ETH');
  });

  it('uninitialized branch surfaces bootstrap-funding.json', async () => {
    // NO earning_state.json — uninitialized. Only a funding gate file.
    const earningDir = mkdtempSync(join(tmpdir(), 'jinn-bootstrap-uninit-funding-'));
    writeFileSync(join(earningDir, 'bootstrap-funding.json'), JSON.stringify({
      schemaVersion: 1,
      master_address: '0xMaster',
      eth_required: '10000000000000000',
      eth_balance: '0',
    }));

    const app = new Hono();
    addBootstrapRoutes(app, { earningDir });
    const res = await app.request('/v1/bootstrap');
    expect(res.status).toBe(200);
    const body = await res.json() as {
      mode: string;
      funding?: {
        master_address?: string;
        eth_required?: string;
        eth_balance?: string;
        targetWei?: string;
        targetMet?: boolean;
      };
    };
    expect(body.mode).toBe('uninitialized');
    expect(body.funding).toBeDefined();
    expect(body.funding!.eth_required).toBe('10000000000000000');
    expect(body.funding!.targetWei).toBe('10000000000000000');
    expect(body.funding!.targetMet).toBe(false);
  });
});

// Issue #367: `/v1/bootstrap` no longer carries the embedded-agent feature
// flag. The operator app reads it (and every feature flag) via the injected
// `window.__JINN_FEATURES__` — see `test/api/feature-flags-inject.test.ts`
// (`isEmbeddedAgentEnabled` + `resolveFeatureFlags`) and the SPA's
// `lib/features.test.ts`.
describe('GET /v1/bootstrap — no feature-flag fields (issue #367)', () => {
  it('does not include embeddedAgentEnabled in the response', async () => {
    const earningDir = makeFixtureEarningDir({
      master_address: '0xabc',
      chain: 'base-sepolia',
      services: [{ index: 0, step: 'complete', safe_address: '0xsafe' }],
    });
    const app = new Hono();
    addBootstrapRoutes(app, { earningDir });
    const res = await app.request('/v1/bootstrap');
    const body = await res.json() as Record<string, unknown>;
    expect('embeddedAgentEnabled' in body).toBe(false);
  });

  it('does not include embeddedAgentEnabled on the uninitialized branch', async () => {
    const earningDir = mkdtempSync(join(tmpdir(), 'jinn-bootstrap-empty-367-'));
    const app = new Hono();
    addBootstrapRoutes(app, { earningDir });
    const res = await app.request('/v1/bootstrap');
    const body = await res.json() as Record<string, unknown>;
    expect(body['mode']).toBe('uninitialized');
    expect('embeddedAgentEnabled' in body).toBe(false);
  });

  it('surfaces onboardingComplete from the configReader in running mode', async () => {
    const earningDir = makeFixtureEarningDir({
      master_address: '0xabc',
      chain: 'base-sepolia',
      services: [{ index: 0, step: 'complete', safe_address: '0xsafe' }],
    });
    const app = new Hono();
    addBootstrapRoutes(app, {
      earningDir,
      configReader: () => ({ onboardingComplete: true }),
    });
    const res = await app.request('/v1/bootstrap');
    const body = (await res.json()) as { mode: string; onboardingComplete?: boolean };
    expect(body.mode).toBe('running');
    expect(body.onboardingComplete).toBe(true);
  });

  it('omits onboardingComplete when the configReader does not set it', async () => {
    const earningDir = makeFixtureEarningDir({
      master_address: '0xabc',
      chain: 'base-sepolia',
      services: [{ index: 0, step: 'complete', safe_address: '0xsafe' }],
    });
    const app = new Hono();
    addBootstrapRoutes(app, { earningDir, configReader: () => ({}) });
    const res = await app.request('/v1/bootstrap');
    const body = (await res.json()) as { onboardingComplete?: boolean };
    expect(body.onboardingComplete).toBeUndefined();
  });

  it('surfaces rpcUrls, publicDefaults and rpcSlotHealth from configReader (#913)', async () => {
    const earningDir = makeFixtureEarningDir({
      master_address: '0xabc',
      chain: 'base-sepolia',
      services: [{ index: 0, step: 'complete', safe_address: '0xsafe' }],
    });
    const app = new Hono();
    addBootstrapRoutes(app, {
      earningDir,
      configReader: () => ({
        rpcUrl: 'https://my-alchemy.example/key',
        defaultRpcUrl: 'https://base-sepolia.publicnode.com',
        rpcUrls: [
          'https://my-alchemy.example/key',
          'https://base-sepolia.publicnode.com',
          'https://sepolia.base.org',
        ],
        publicDefaults: [
          'https://base-sepolia.publicnode.com',
          'https://sepolia.base.org',
        ],
        rpcSlotHealth: [
          {
            ok: true,
            host: 'my-alchemy.example',
            latencyMs: 12,
            expectedChainId: 84532,
            actualChainId: 84532,
          },
          {
            ok: false,
            host: 'base-sepolia.publicnode.com',
            reason: 'chain_mismatch',
            expectedChainId: 84532,
            actualChainId: 8453,
          },
          { ok: false, host: 'sepolia.base.org', code: 429 },
        ],
      }),
    });
    const res = await app.request('/v1/bootstrap');
    expect(res.status).toBe(200);
    const body = await res.json() as {
      rpcUrls: string[];
      publicDefaults: string[];
      rpcSlotHealth: Array<{
        ok: boolean;
        host: string;
        latencyMs?: number;
        code?: number;
        reason?: string;
        expectedChainId?: number;
        actualChainId?: number;
      }>;
    };
    expect(body.rpcUrls).toEqual([
      'https://my-alchemy.example/key',
      'https://base-sepolia.publicnode.com',
      'https://sepolia.base.org',
    ]);
    expect(body.publicDefaults).toEqual([
      'https://base-sepolia.publicnode.com',
      'https://sepolia.base.org',
    ]);
    expect(body.rpcSlotHealth).toHaveLength(3);
    expect(body.rpcSlotHealth[1]).toEqual({
      ok: false,
      host: 'base-sepolia.publicnode.com',
      reason: 'chain_mismatch',
      expectedChainId: 84532,
      actualChainId: 8453,
    });
    expect(body.rpcSlotHealth[2]).toEqual({ ok: false, host: 'sepolia.base.org', code: 429 });
  });

  it('omits the new RPC fields when no configReader is supplied (back-compat)', async () => {
    const earningDir = makeFixtureEarningDir({
      master_address: '0xabc',
      chain: 'base-sepolia',
      services: [{ index: 0, step: 'complete', safe_address: '0xsafe' }],
    });
    const app = new Hono();
    addBootstrapRoutes(app, { earningDir });
    const res = await app.request('/v1/bootstrap');
    const body = await res.json() as Record<string, unknown>;
    expect(body).not.toHaveProperty('rpcUrls');
    expect(body).not.toHaveProperty('publicDefaults');
    expect(body).not.toHaveProperty('rpcSlotHealth');
  });
});
