import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  createCliReadOnlySignerContext,
  pickPrimaryMechService,
} from '../../src/cli/execution-context.js';
import type { ServiceState } from '../../src/earning/types.js';
import { FleetStateStore, STATE_FILE } from '../../src/earning/store.js';
import { encryptMnemonic } from '../../src/earning/wallet.js';

function svc(partial: Partial<ServiceState> & Pick<ServiceState, 'index' | 'step'>): ServiceState {
  return {
    agent_address: '0x0000000000000000000000000000000000000001',
    safe_address: null,
    service_id: null,
    mech_address: null,
    staking_address: null,
    error: null,
    ...partial,
  };
}

describe('pickPrimaryMechService', () => {
  it('returns the first complete service with safe and mech', () => {
    const a = svc({
      index: 1,
      step: 'complete',
      safe_address: '0x1111111111111111111111111111111111111111',
      mech_address: '0x2222222222222222222222222222222222222222',
    });
    const b = svc({
      index: 2,
      step: 'complete',
      safe_address: '0x3333333333333333333333333333333333333333',
      mech_address: null,
    });
    expect(pickPrimaryMechService([b, a])).toEqual(a);
  });

  it('returns undefined when no eligible service', () => {
    expect(
      pickPrimaryMechService([
        svc({ index: 1, step: 'complete', safe_address: '0x1111111111111111111111111111111111111111' }),
      ]),
    ).toBeUndefined();
  });
});

describe('createCliReadOnlySignerContext', () => {
  it('does not create, rename, or rewrite fleet files for missing or invalid state', async () => {
    const root = mkdtempSync(join(tmpdir(), 'jinn-readonly-signer-'));
    const password = 'test-password';
    const makeConfig = (earningDir: string, name: string) => {
      const path = join(root, `${name}.json`);
      writeFileSync(path, JSON.stringify({
        network: 'testnet',
        earningDir,
        rpcUrl: 'http://127.0.0.1:1',
      }));
      return path;
    };

    const missingKeystoreDir = join(root, 'missing-keystore');
    const missingKeystore = await createCliReadOnlySignerContext({
      argv: ['--config', makeConfig(missingKeystoreDir, 'missing-keystore')],
      env: { JINN_PASSWORD: password },
    });
    expect(missingKeystore.ok).toBe(false);
    expect(existsSync(missingKeystoreDir)).toBe(false);

    const earningDir = join(root, 'earning');
    const fleetStore = new FleetStateStore(earningDir);
    await fleetStore.saveMnemonicKeystore(await encryptMnemonic(
      'test test test test test test test test test test test junk',
      password,
    ));
    const missingStateBefore = readdirSync(earningDir);
    const missingState = await createCliReadOnlySignerContext({
      argv: ['--config', makeConfig(earningDir, 'missing-state')],
      env: { JINN_PASSWORD: password },
    });
    expect(missingState.ok).toBe(false);
    expect(readdirSync(earningDir)).toEqual(missingStateBefore);
    expect(existsSync(join(earningDir, STATE_FILE))).toBe(false);

    const invalidStatePath = join(earningDir, STATE_FILE);
    writeFileSync(invalidStatePath, '{"invalid":true}\n');
    const invalidBefore = readFileSync(invalidStatePath, 'utf8');
    const filesBefore = readdirSync(earningDir);
    const invalidState = await createCliReadOnlySignerContext({
      argv: ['--config', makeConfig(earningDir, 'invalid-state')],
      env: { JINN_PASSWORD: password },
    });
    expect(invalidState.ok).toBe(false);
    expect(readFileSync(invalidStatePath, 'utf8')).toBe(invalidBefore);
    expect(readdirSync(earningDir)).toEqual(filesBefore);
  });
});
