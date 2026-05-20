import { test as base } from '@playwright/test';
import { setupTier2Scenario, type Tier2Handle } from '../../../release/tier-2/tier-2-helpers';

interface TwoSubstrateOpsFixtures {
  tier2: Tier2Handle;
  opAUrl: string;
  opBUrl: string;
}

export const test = base.extend<TwoSubstrateOpsFixtures>({
  tier2: async ({}, use, testInfo) => {
    const handle = await setupTier2Scenario({
      scenarioId: testInfo.titlePath.join('-').replace(/[^a-zA-Z0-9-]/g, '_'),
      // T2.3 port range. Each Tier 2 scenario reserves a 10-port block to avoid
      // collisions under parallel runs: tier-2-helpers tests 7740-7743,
      // T2.1 7750-7751, T2.2 7760-7761, T2.3 7770-7771.
      portBase: 7770,
    });
    try {
      await use(handle);
    } finally {
      await handle.teardown();
    }
  },
  opAUrl: async ({ tier2 }, use) => {
    const url = tier2.daemons.daemons['op-a'].handshakeUrl ?? `http://127.0.0.1:${tier2.daemons.daemons['op-a'].apiPort}/`;
    await use(url);
  },
  opBUrl: async ({ tier2 }, use) => {
    const url = tier2.daemons.daemons['op-b'].handshakeUrl ?? `http://127.0.0.1:${tier2.daemons.daemons['op-b'].apiPort}/`;
    await use(url);
  },
});

export { expect } from '@playwright/test';
