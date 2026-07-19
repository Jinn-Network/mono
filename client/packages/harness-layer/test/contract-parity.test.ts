import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { PROCESS_CONTRACT_VERSION, PROCESS_STATUSES } from '../src/process-contract.js';

interface CanonicalProcessContract {
  contractVersion: number;
  processStatuses: string[];
}

const CONTRACT_PATH = fileURLToPath(
  new URL('../../../../packages/plugin/process-contract.json', import.meta.url),
);
const TYPESCRIPT_PATH = fileURLToPath(new URL('../src/process-contract.ts', import.meta.url));
const contract = JSON.parse(
  readFileSync(CONTRACT_PATH, 'utf8'),
) as CanonicalProcessContract;

describe('canonical process-contract constant parity (#1822)', () => {
  it('PROCESS_CONTRACT_VERSION matches the canonical contract', () => {
    expect(
      PROCESS_CONTRACT_VERSION,
      `PROCESS_CONTRACT_VERSION diverged: TypeScript=${PROCESS_CONTRACT_VERSION} ` +
        `(${TYPESCRIPT_PATH}) != canonical=${contract.contractVersion} (${CONTRACT_PATH})`,
    ).toBe(contract.contractVersion);
  });

  it('PROCESS_STATUSES matches the canonical contract', () => {
    const typescriptStatuses = [...PROCESS_STATUSES].sort();
    const canonicalStatuses = [...contract.processStatuses].sort();

    expect(
      typescriptStatuses,
      `PROCESS_STATUSES diverged: TypeScript=[${typescriptStatuses}] (${TYPESCRIPT_PATH}) != ` +
        `canonical=[${canonicalStatuses}] (${CONTRACT_PATH})`,
    ).toEqual(canonicalStatuses);
  });
});
