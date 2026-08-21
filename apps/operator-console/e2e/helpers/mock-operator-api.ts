import type { Page } from '@playwright/test';

export const STATUS_WITH_CONTRACT = {
  schemaVersion: 1,
  contractVersion: { major: 1, minor: 0 },
  fleet: {
    masterAddress: '0xE64bAf0073a71b0Cb2C0558bB16f24b45E1FB5CF',
    services: [
      {
        index: 1,
        step: 'complete',
        serviceId: 76,
        safeAddress: '0x0e767E28C6889CcD0DfB88E631a3702D56Ce24FC',
        agentId: '5474',
        safeBoundToAgent: true,
      },
    ],
  },
  balances: {
    eth: {
      agent: { address: '0xFf26BFE3e987556a207D77ae2ff0c6EA030CC3E9' },
    },
  },
  postingEntries: 0,
};

export const RUNNING_BOOTSTRAP = {
  schemaVersion: 1,
  mode: 'running',
  onboardingComplete: true,
  steps: ['wallet'],
  currentStep: 'complete',
  services: [
    { index: 1, step: 'complete', safe_address: '0x0e767E28C6889CcD0DfB88E631a3702D56Ce24FC' },
  ],
  master_address: '0xE64bAf0073a71b0Cb2C0558bB16f24b45E1FB5CF',
  chain: 'base-sepolia',
  rpcUrls: ['https://sepolia.base.org'],
  publicDefaults: ['https://sepolia.base.org'],
};

export async function mockOperatorApi(page: Page): Promise<void> {
  await page.route(
    (url) => url.pathname === '/v1/status',
    (route) =>
      route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify(STATUS_WITH_CONTRACT),
      }),
  );
  await page.route(
    (url) => url.pathname === '/v1/bootstrap',
    (route) =>
      route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify(RUNNING_BOOTSTRAP),
      }),
  );
  await page.route(
    (url) => url.pathname === '/v1/rewards',
    (route) =>
      route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({
          schemaVersion: 1,
          readState: 'ready',
          totalPending: '0',
          totalClaimed: '0',
          lastClaimAt: null,
          lastClaimTickAt: null,
          nextCheckpointAt: null,
          services: [],
        }),
      }),
  );
  await page.route(
    (url) => url.pathname === '/v1/notifications',
    (route) =>
      route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({
          schemaVersion: 1,
          contractVersion: { major: 1, minor: 0 },
          generatedAt: new Date().toISOString(),
          notifications: [],
        }),
      }),
  );
  await page.route(
    (url) => url.pathname === '/v1/discovery/task-post-counts',
    (route) =>
      route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({ chain: { h1: 0, h6: 0, h24: 0 }, byCid: {} }),
      }),
  );
  await page.route(
    (url) => url.pathname === '/v1/events' || url.pathname === '/v1/events/recent',
    (route) => {
      if (url.pathname === '/v1/events') {
        return route.fulfill({
          contentType: 'text/event-stream',
          body: '',
        });
      }
      return route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({ events: [] }),
      });
    },
  );
  await page.route(
    (url) => url.pathname.startsWith('/v1/operator/'),
    (route) =>
      route.fulfill({ contentType: 'application/json', body: JSON.stringify({ ok: true }) }),
  );
}
