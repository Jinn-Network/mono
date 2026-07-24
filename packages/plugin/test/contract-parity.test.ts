import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { JINN_PLUGIN_CONTRACT_VERSION } from '../src/index.js';

interface CanonicalProcessContract {
  contractVersion: number;
}

const CONTRACT_PATH = fileURLToPath(new URL('../process-contract.json', import.meta.url));
const TYPESCRIPT_PATH = fileURLToPath(new URL('../src/plugin.ts', import.meta.url));
const contract = JSON.parse(
  readFileSync(CONTRACT_PATH, 'utf8'),
) as CanonicalProcessContract;

describe('canonical process-contract constant parity (#1822)', () => {
  it('JINN_PLUGIN_CONTRACT_VERSION matches the canonical contract', () => {
    expect(
      JINN_PLUGIN_CONTRACT_VERSION,
      `JINN_PLUGIN_CONTRACT_VERSION diverged: TypeScript=${JINN_PLUGIN_CONTRACT_VERSION} ` +
        `(${TYPESCRIPT_PATH}) != canonical=${contract.contractVersion} (${CONTRACT_PATH})`,
    ).toBe(contract.contractVersion);
  });
});
