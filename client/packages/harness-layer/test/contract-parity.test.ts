import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { PROCESS_CONTRACT_VERSION } from '../src/process-contract.js';

// Cross-language contract-constant parity (Jinn-Network/mono#1822): the Python
// side declares its own literals (CONTRACT_VERSION and the inline status guard
// tuple); read its source as text so a one-sided bump fails here naming the
// divergent constant. ProcessStatus is a type alias, so it is regexed out of
// this package's own source too — types do not exist at runtime.
const PY_JINN_LAYER = fileURLToPath(
  new URL('../../../../apps/jinn-agent/plugins/jinn/jinn_layer.py', import.meta.url),
);
const TS_PROCESS_CONTRACT = fileURLToPath(new URL('../src/process-contract.ts', import.meta.url));

describe('cross-language contract-constant parity (#1822)', () => {
  it('Python CONTRACT_VERSION matches PROCESS_CONTRACT_VERSION', () => {
    const source = readFileSync(PY_JINN_LAYER, 'utf8');
    const match = /^CONTRACT_VERSION = (\d+)$/m.exec(source);
    expect(
      match,
      `could not locate CONTRACT_VERSION in ${PY_JINN_LAYER} — declaration moved?`,
    ).not.toBeNull();
    const pyVersion = Number(match![1]);
    expect(
      pyVersion,
      `contract version diverged: Python CONTRACT_VERSION=${pyVersion} (${PY_JINN_LAYER}) != ` +
        `TS PROCESS_CONTRACT_VERSION=${PROCESS_CONTRACT_VERSION} (${TS_PROCESS_CONTRACT})`,
    ).toBe(PROCESS_CONTRACT_VERSION);
  });

  it('Python status guard tuple matches the ProcessStatus union', () => {
    const pySource = readFileSync(PY_JINN_LAYER, 'utf8');
    const pyMatch = /parsed\.get\("status"\) not in \(([^)]+)\)/.exec(pySource);
    expect(
      pyMatch,
      `could not locate the status guard tuple in ${PY_JINN_LAYER} — declaration moved?`,
    ).not.toBeNull();
    const pyStatuses = [...pyMatch![1].matchAll(/"([^"]+)"/g)].map((m) => m[1]).sort();

    const tsSource = readFileSync(TS_PROCESS_CONTRACT, 'utf8');
    const tsMatch = /export type ProcessStatus\s*=\s*([^;]+);/.exec(tsSource);
    expect(
      tsMatch,
      `could not locate the ProcessStatus union in ${TS_PROCESS_CONTRACT} — declaration moved?`,
    ).not.toBeNull();
    const tsStatuses = [...tsMatch![1].matchAll(/'([^']+)'/g)].map((m) => m[1]).sort();

    expect(
      pyStatuses,
      `process-status set diverged: Python [${pyStatuses}] (${PY_JINN_LAYER}) != ` +
        `TS ProcessStatus [${tsStatuses}] (${TS_PROCESS_CONTRACT})`,
    ).toEqual(tsStatuses);
  });
});
