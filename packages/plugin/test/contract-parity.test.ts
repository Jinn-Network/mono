import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { JINN_PLUGIN_CONTRACT_VERSION } from '../src/index.js';

// Cross-language contract-constant parity (Jinn-Network/mono#1822): the Python
// side declares its own CONTRACT_VERSION literal; read its source as text so a
// one-sided bump fails here naming the divergent constant.
const PY_JINN_LAYER = fileURLToPath(
  new URL('../../../apps/jinn-agent/plugins/jinn/jinn_layer.py', import.meta.url),
);
const TS_PLUGIN = fileURLToPath(new URL('../src/plugin.ts', import.meta.url));

describe('cross-language contract-constant parity (#1822)', () => {
  it('Python CONTRACT_VERSION matches JINN_PLUGIN_CONTRACT_VERSION', () => {
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
        `TS JINN_PLUGIN_CONTRACT_VERSION=${JINN_PLUGIN_CONTRACT_VERSION} (${TS_PLUGIN})`,
    ).toBe(JINN_PLUGIN_CONTRACT_VERSION);
  });
});
