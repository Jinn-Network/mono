import { expect } from 'chai';

import {
  DEFAULT_AGENT_INSTANCE,
  DEFAULT_CURRENT_PROXY,
  DEFAULT_FRESH_PROXY,
  DEFAULT_MASTER,
  DEFAULT_RECOVERY_MODULE,
  DEFAULT_REGISTRY_OWNER,
  DEFAULT_SERVICE_ID,
  OPERATOR_SAFE,
  assertAnvilForkNodeInfo,
  padAddressToBytes32,
  resolveMigrationConfig,
  verifyFinalState,
  type FinalStateSnapshot,
} from '../scripts/rehearse-stolas-service-migration.js';

const SERVICE_CONFIG_HASH =
  '0x16842ca711d5673bb6485655eac9b6a0034e09ae07ee845ec8700573e58f0101';

describe('stOLAS service migration rehearsal script helpers', function () {
  it('formats the current staking proxy as the unstake operation bytes32', function () {
    expect(padAddressToBytes32(DEFAULT_CURRENT_PROXY)).to.equal(
      '0x00000000000000000000000024e34E5037956a5Feca1AAAfaA30297084C228B8',
    );
  });

  it('resolves conservative defaults from the repository deployment artifacts', function () {
    const config = resolveMigrationConfig({ env: {}, cwd: process.cwd() });

    expect(config.serviceId).to.equal(DEFAULT_SERVICE_ID);
    expect(config.currentProxy).to.equal(DEFAULT_CURRENT_PROXY);
    expect(config.freshProxy).to.equal(DEFAULT_FRESH_PROXY);
    expect(config.recoveryModule).to.equal(DEFAULT_RECOVERY_MODULE);
    expect(config.registryOwner).to.equal(DEFAULT_REGISTRY_OWNER);
    expect(config.master).to.equal(DEFAULT_MASTER);
    expect(config.agentInstance).to.equal(DEFAULT_AGENT_INSTANCE);
    expect(config.evidencePath).to.match(
      /\.local\/stolas-service46-fresh-proxy-rehearsal\.json$/,
    );
  });

  it('accepts both anvil fork node-info shapes and rejects non-fork nodes', function () {
    expect(() =>
      assertAnvilForkNodeInfo({
        fork_config: { fork_url: 'https://sepolia.base.org' },
      }),
    ).not.to.throw();
    expect(() =>
      assertAnvilForkNodeInfo({
        forkConfig: { forkUrl: 'https://sepolia.base.org' },
      }),
    ).not.to.throw();

    expect(() => assertAnvilForkNodeInfo({})).to.throw(/Anvil fork/);
    expect(() => assertAnvilForkNodeInfo(null)).to.throw(/Anvil fork/);
  });

  it('verifies the final fresh-proxy state snapshot', function () {
    const validState: FinalStateSnapshot = {
      currentStakingState: 0n,
      freshStakingState: 1n,
      ownerOfService: DEFAULT_FRESH_PROXY,
      freshServiceIds: [46n],
      serviceMultisig: OPERATOR_SAFE,
      serviceConfigHash: SERVICE_CONFIG_HASH,
      serviceAgentIds: [103n],
    };

    expect(() =>
      verifyFinalState(validState, {
        serviceId: DEFAULT_SERVICE_ID,
        freshProxy: DEFAULT_FRESH_PROXY,
        expectedConfigHash: SERVICE_CONFIG_HASH,
      }),
    ).not.to.throw();

    expect(() =>
      verifyFinalState(
        { ...validState, freshServiceIds: [] },
        {
          serviceId: DEFAULT_SERVICE_ID,
          freshProxy: DEFAULT_FRESH_PROXY,
          expectedConfigHash: SERVICE_CONFIG_HASH,
        },
      ),
    ).to.throw(/fresh staking proxy does not list service/);

    expect(() =>
      verifyFinalState(
        { ...validState, ownerOfService: DEFAULT_CURRENT_PROXY },
        {
          serviceId: DEFAULT_SERVICE_ID,
          freshProxy: DEFAULT_FRESH_PROXY,
          expectedConfigHash: SERVICE_CONFIG_HASH,
        },
      ),
    ).to.throw(/ownerOf/);

    expect(() =>
      verifyFinalState(
        { ...validState, serviceConfigHash: `0x${'00'.repeat(32)}` },
        {
          serviceId: DEFAULT_SERVICE_ID,
          freshProxy: DEFAULT_FRESH_PROXY,
          expectedConfigHash: SERVICE_CONFIG_HASH,
        },
      ),
    ).to.throw(/config hash/);
  });
});
