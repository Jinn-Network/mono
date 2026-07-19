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

function stripPythonNonCode(source: string): string {
  const chars = [...source];
  let index = 0;
  let quote: '"' | "'" | '"""' | "'''" | null = null;
  while (index < chars.length) {
    const char = chars[index];
    const following = chars[index + 1];
    if (quote !== null) {
      if (char === '\\') {
        index += 2;
        continue;
      }
      if (chars.slice(index, index + quote.length).join('') === quote) {
        index += quote.length;
        quote = null;
      } else {
        index += 1;
      }
      continue;
    }
    if ((char === '"' || char === "'") && following === char && chars[index + 2] === char) {
      const delimiter = char.repeat(3) as '"""' | "'''";
      const lineStart = Math.max(source.lastIndexOf('\n', index - 1), source.lastIndexOf('\r', index - 1)) + 1;
      const isStandalone = /^[ \t]*(?:[rRuUbB]{1,2})?$/u.test(source.slice(lineStart, index));
      if (!isStandalone) {
        quote = delimiter;
        index += delimiter.length;
        continue;
      }
      for (let count = 0; count < delimiter.length; count += 1) chars[index + count] = ' ';
      index += 3;
      while (index < chars.length) {
        if (chars.slice(index, index + 3).join('') === delimiter) {
          for (let count = 0; count < delimiter.length; count += 1) chars[index + count] = ' ';
          index += 3;
          break;
        }
        if (chars[index] !== '\n' && chars[index] !== '\r') chars[index] = ' ';
        index += 1;
      }
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      index += 1;
      continue;
    }
    if (char === '#') {
      while (index < chars.length && chars[index] !== '\n' && chars[index] !== '\r') {
        chars[index] = ' ';
        index += 1;
      }
      continue;
    }
    index += 1;
  }
  return chars.join('');
}

function extractPythonVersion(source: string, sourcePath: string): number {
  const matches = [
    ...stripPythonNonCode(source).matchAll(/^CONTRACT_VERSION[ \t]*=[ \t]*(\d+)[ \t]*$/gm),
  ];
  if (matches.length === 0) {
    throw new Error(`could not locate CONTRACT_VERSION in ${sourcePath} — declaration moved?`);
  }
  if (matches.length !== 1) {
    throw new Error(
      `expected exactly one CONTRACT_VERSION in ${sourcePath}, found ${matches.length} declaration-shaped matches`,
    );
  }
  return Number(matches[0][1]);
}

describe('cross-language contract-constant parity (#1822)', () => {
  it('ignores a Python docstring CONTRACT_VERSION decoy', () => {
    const source = `"""
CONTRACT_VERSION = 1
"""
# CONTRACT_VERSION = 1
marker = "# not a comment"
assigned = '''
# still not a comment
'''
CONTRACT_VERSION = 2`;

    expect(extractPythonVersion(source, 'fixture-jinn-layer.py')).toBe(2);
  });

  it('rejects multiple live Python CONTRACT_VERSION declarations', () => {
    const source = `CONTRACT_VERSION = 1
CONTRACT_VERSION = 2`;

    expect(() => extractPythonVersion(source, 'fixture-jinn-layer.py')).toThrow(
      /exactly one CONTRACT_VERSION.*fixture-jinn-layer\.py/,
    );
  });

  it('Python CONTRACT_VERSION matches JINN_PLUGIN_CONTRACT_VERSION', () => {
    const source = readFileSync(PY_JINN_LAYER, 'utf8');
    const pyVersion = extractPythonVersion(source, PY_JINN_LAYER);
    expect(
      pyVersion,
      `contract version diverged: Python CONTRACT_VERSION=${pyVersion} (${PY_JINN_LAYER}) != ` +
        `TS JINN_PLUGIN_CONTRACT_VERSION=${JINN_PLUGIN_CONTRACT_VERSION} (${TS_PLUGIN})`,
    ).toBe(JINN_PLUGIN_CONTRACT_VERSION);
  });
});
