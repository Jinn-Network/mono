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

function extractPythonStatuses(source: string, sourcePath: string): string[] {
  const match = /^[ \t]*if[ \t]+parsed\.get\("status"\)[ \t]+not[ \t]+in[ \t]+\(([^)]*)\)[ \t]*:/m.exec(
    source,
  );
  if (!match) {
    throw new Error(`could not locate the status guard tuple in ${sourcePath} — declaration moved?`);
  }
  const body = match[1];
  if (!/^[ \t\r\n]*"[^"\r\n]+"(?:[ \t\r\n]*,[ \t\r\n]*"[^"\r\n]+")*[ \t\r\n]*,?[ \t\r\n]*$/u.test(body)) {
    throw new Error(`unsupported syntax in status guard tuple in ${sourcePath}: ${body}`);
  }
  return [...body.matchAll(/"([^"]+)"/g)].map((member) => member[1]).sort();
}

function extractTsStatuses(source: string, sourcePath: string): string[] {
  const match = /^export[ \t]+type[ \t]+ProcessStatus[ \t]*=[ \t]*([^;]+);/m.exec(source);
  if (!match) {
    throw new Error(`could not locate the ProcessStatus union in ${sourcePath} — declaration moved?`);
  }
  const body = match[1];
  if (!/^[ \t\r\n]*'[^'\r\n]+'(?:[ \t\r\n]*\|[ \t\r\n]*'[^'\r\n]+')*[ \t\r\n]*$/u.test(body)) {
    throw new Error(`unsupported syntax in ProcessStatus union in ${sourcePath}: ${body}`);
  }
  return [...body.matchAll(/'([^']+)'/g)].map((member) => member[1]).sort();
}

describe('cross-language contract-constant parity (#1822)', () => {
  it('rejects an unrecognized Python status guard member', () => {
    expect(() =>
      extractPythonStatuses(
        'if parsed.get("status") not in ("ok", EXTRA_STATUS):',
        'fixture-jinn-layer.py',
      ),
    ).toThrow(/status guard tuple.*fixture-jinn-layer\.py/);
  });

  it('rejects an unrecognized ProcessStatus union member', () => {
    expect(() =>
      extractTsStatuses("export type ProcessStatus = 'ok' | ExtraStatus;", 'fixture-process-contract.ts'),
    ).toThrow(/ProcessStatus union.*fixture-process-contract\.ts/);
  });

  // PROCESS_CONTRACT_VERSION is a re-export of the plugin package's
  // JINN_PLUGIN_CONTRACT_VERSION, so this assertion is structurally the same
  // check as packages/plugin/test/contract-parity.test.ts — it exists so the
  // client CI path (plain `yarn test`) also gates the cross-language pin.
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
        `TS PROCESS_CONTRACT_VERSION=${PROCESS_CONTRACT_VERSION} (re-exported from ` +
        `packages/plugin/src/plugin.ts, where the TS literal lives; ${TS_PROCESS_CONTRACT} ` +
        `just re-exports it)`,
    ).toBe(PROCESS_CONTRACT_VERSION);
  });

  it('Python status guard tuple matches the ProcessStatus union', () => {
    const pySource = readFileSync(PY_JINN_LAYER, 'utf8');
    const pyStatuses = extractPythonStatuses(pySource, PY_JINN_LAYER);

    const tsSource = readFileSync(TS_PROCESS_CONTRACT, 'utf8');
    const tsStatuses = extractTsStatuses(tsSource, TS_PROCESS_CONTRACT);

    expect(
      pyStatuses,
      `process-status set diverged: Python [${pyStatuses}] (${PY_JINN_LAYER}) != ` +
        `TS ProcessStatus [${tsStatuses}] (${TS_PROCESS_CONTRACT})`,
    ).toEqual(tsStatuses);
  });
});
