import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createDefaultFleetState,
  createDefaultServiceState,
} from '../../src/earning/types.js';
import { FleetStateStore } from '../../src/earning/store.js';
import {
  deriveAgentAddress,
  encryptMnemonic,
  generateMnemonic,
  walletPrivateKeyAtIndex,
} from '../../src/earning/wallet.js';
import { deriveOperatorIdentity } from '../../scripts/layer-operator-identity.js';

const SAFE_ADDRESS = `0x${'1'.repeat(40)}`;

describe('layer operator identity', () => {
  const temporaryDirectories: string[] = [];

  afterEach(async () => {
    await Promise.all(
      temporaryDirectories
        .splice(0)
        .map((directory) => rm(directory, { recursive: true, force: true })),
    );
  });

  async function operatorFixture(agentAddress?: string) {
    const earningDir = await mkdtemp(join(tmpdir(), 'jinn-layer-identity-'));
    temporaryDirectories.push(earningDir);
    const password = 'operator-test-password';
    const mnemonic = generateMnemonic();
    const store = new FleetStateStore(earningDir);
    await store.saveMnemonicKeystore(await encryptMnemonic(mnemonic, password));

    const service = createDefaultServiceState(
      1,
      agentAddress ?? deriveAgentAddress(mnemonic, 1),
    );
    await store.save({
      ...createDefaultFleetState('base-sepolia'),
      services: [
        {
          ...service,
          safe_address: SAFE_ADDRESS,
          agent_id: '42',
          step: 'complete',
        },
      ],
    });
    return { earningDir, password, mnemonic };
  }

  it('derives the live signer and public operator identity from one bootstrapped service', async () => {
    const fixture = await operatorFixture();

    const identity = await deriveOperatorIdentity([], {
      earningDir: fixture.earningDir,
      env: { JINN_PASSWORD: fixture.password },
    });

    expect(identity).toEqual({
      privateKey: walletPrivateKeyAtIndex(fixture.mnemonic, 1),
      safeAddress: SAFE_ADDRESS,
      agentId: 42n,
      agentAddress: deriveAgentAddress(fixture.mnemonic, 1),
      serviceIndex: 1,
    });
  });

  it('fails closed when the encrypted wallet does not match the stored agent address', async () => {
    const fixture = await operatorFixture(`0x${'2'.repeat(40)}`);

    await expect(
      deriveOperatorIdentity([], {
        earningDir: fixture.earningDir,
        env: { JINN_PASSWORD: fixture.password },
      }),
    ).rejects.toThrow(/derived wallet.*stored agent address/i);
  });

  it('does not expose password material when keystore decryption fails', async () => {
    const fixture = await operatorFixture();
    const wrongPassword = 'never-print-this-password';

    await expect(
      deriveOperatorIdentity([], {
        earningDir: fixture.earningDir,
        env: { JINN_PASSWORD: wrongPassword },
      }),
    ).rejects.toThrow('could not decrypt keystore (wrong password?)');

    await expect(
      deriveOperatorIdentity([], {
        earningDir: fixture.earningDir,
        env: { JINN_PASSWORD: wrongPassword },
      }),
    ).rejects.not.toThrow(wrongPassword);
  });
});
