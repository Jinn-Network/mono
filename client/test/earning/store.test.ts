import { describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FleetStateStore } from '../../src/earning/store.js';
import { createDefaultFleetState } from '../../src/earning/types.js';

describe('FleetStateStore chain isolation', () => {
  it('archives chain-specific fleet files when persisted state does not match runtime chain', async () => {
    const earningDir = mkdtempSync(join(tmpdir(), 'jinn-earning-chain-'));
    const state = {
      ...createDefaultFleetState('base'),
      master_address: '0x78a7C2d276449500700Bc596b3102573Ea17F135',
    };
    writeFileSync(join(earningDir, 'earning_state.json'), `${JSON.stringify(state)}\n`);
    writeFileSync(join(earningDir, 'earning_migrations.json'), '{"schemaVersion":1,"entries":[]}\n');
    writeFileSync(join(earningDir, 'bootstrap-funding.json'), '{}\n');
    writeFileSync(join(earningDir, 'bootstrap-error.json'), '{}\n');
    writeFileSync(join(earningDir, 'master_keystore.json'), '{"crypto":"preserved"}\n');

    const result = await new FleetStateStore(earningDir).archiveIfChainMismatch('base-sepolia');

    expect(result).toMatchObject({
      expectedChain: 'base-sepolia',
      actualChain: 'base',
    });
    expect(existsSync(join(earningDir, 'earning_state.json'))).toBe(false);
    expect(existsSync(join(earningDir, 'earning_migrations.json'))).toBe(false);
    expect(existsSync(join(earningDir, 'bootstrap-funding.json'))).toBe(false);
    expect(existsSync(join(earningDir, 'bootstrap-error.json'))).toBe(false);
    expect(existsSync(join(earningDir, 'master_keystore.json'))).toBe(true);
    expect(readdirSync(earningDir).filter((name) => name.includes('archived-for-base-sepolia'))).toHaveLength(4);
  });

  it('keeps matching runtime chain state in place', async () => {
    const earningDir = mkdtempSync(join(tmpdir(), 'jinn-earning-chain-'));
    writeFileSync(
      join(earningDir, 'earning_state.json'),
      `${JSON.stringify(createDefaultFleetState('base-sepolia'))}\n`,
    );

    const result = await new FleetStateStore(earningDir).archiveIfChainMismatch('base-sepolia');

    expect(result).toBeNull();
    expect(existsSync(join(earningDir, 'earning_state.json'))).toBe(true);
  });
});
