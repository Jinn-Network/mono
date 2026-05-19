/**
 * Shared Playwright route-interception helper for the operator dashboard SPA
 * tests. Mocks all daemon API endpoints so the SPA renders running-mode
 * without a live bootstrapped fleet.
 *
 * Uses host-agnostic `**\/v1/...` glob patterns so the mocks match any port.
 * The optional `port` argument is reserved for forward-compatibility when
 * multi-op tests need per-port matching (not yet implemented).
 */
import type { Page } from '@playwright/test';

export interface MockDaemonApiOptions {
  /**
   * Port the daemon would normally run on. Reserved for future use; the
   * current implementation uses host-agnostic globs (`**\/v1/...`) so the
   * mocks match any port. Multi-op tests can still pass the port for clarity.
   */
  port?: number;
}

/** Default payloads — exported so callers can spread + override per-test. */
export const DEFAULT_RUNNING_BOOTSTRAP = {
  schemaVersion: 1,
  mode: 'running',
  steps: ['wallet'],
  currentStep: 'complete',
  services: [
    { index: 1, step: 'complete', safe_address: '0x0e767E28C6889CcD0DfB88E631a3702D56Ce24FC' },
  ],
  master_address: '0xE64bAf0073a71b0Cb2C0558bB16f24b45E1FB5CF',
  chain: 'base-sepolia',
  rpcUrl: 'https://sepolia.base.org',
  defaultRpcUrl: 'https://sepolia.base.org',
  solverNets: {
    prediction: {
      enabled: true,
      roles: ['solving'],
      harness: 'claude-code-learner',
      model: 'claude-haiku-4-5-20251001',
      plugins: ['jinn-prediction-plugin'],
    },
  },
} as const;

export const DEFAULT_STATUS_PAYLOAD = {
  schemaVersion: 1,
  fleet: { services: [{ index: 1, step: 'complete', safeAddress: '0x0e767E28C6889CcD0DfB88E631a3702D56Ce24FC', agentId: 5474, safeBoundToAgent: true }] },
  predictionV1: {
    operator: {
      ok: true,
      enabled: true,
      diagnostics: [],
      solverNet: { name: 'prediction', enabled: true, roles: ['solving'] },
      nextAction: { description: 'Waiting for Tasks. SolverNet active, Harness loaded.' },
    },
    totals: { observedTasks: 0, activeTaskRuns: 0, solutions: 0, verdicts: 0, failed: 0 },
  },
  rewards: { pendingStakingRewardsWei: '0' },
  masterGas: { balanceWei: '0', runwayDaysExcess: '4' },
} as const;

export const DEFAULT_SOLVERNETS_CATALOG = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  nets: [
    {
      name: 'prediction',
      description: 'Forecast resolved outcomes; rewarded by Brier score on verified resolutions.',
      contract: { id: 'prediction', version: 'v1' },
      state: 'live',
      supportedRoles: ['solving', 'evaluating'],
      compatibleHarnesses: [{ name: 'claude-code-learner', version: '0.1.0', supportsRoles: ['solving', 'evaluating'] }],
      compatiblePlugins: [{ name: 'jinn-prediction-plugin', version: '0.1.0', source: 'bundled' }],
    },
  ],
} as const;

export async function mockDaemonApi(page: Page, _opts: MockDaemonApiOptions = {}): Promise<void> {
  await page.route(`**/v1/bootstrap`, (route) =>
    route.fulfill({ contentType: 'application/json', body: JSON.stringify(DEFAULT_RUNNING_BOOTSTRAP) }),
  );
  await page.route(`**/v1/status`, (route) =>
    route.fulfill({ contentType: 'application/json', body: JSON.stringify(DEFAULT_STATUS_PAYLOAD) }),
  );
  await page.route(`**/v1/solvernets`, (route) =>
    route.fulfill({ contentType: 'application/json', body: JSON.stringify(DEFAULT_SOLVERNETS_CATALOG) }),
  );
  await page.route(`**/v1/setup/solvernets/prediction`, (route) =>
    route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        ok: true,
        restartRequired: true,
        name: 'prediction',
        config: { enabled: true, roles: ['solving', 'evaluating'] },
      }),
    }),
  );
  // Suppress the auth handshake redirect; the SPA will silently fall back.
  await page.route(`**/auth/handshake**`, (route) =>
    route.fulfill({ contentType: 'application/json', body: '{"ok":true}' }),
  );
}
