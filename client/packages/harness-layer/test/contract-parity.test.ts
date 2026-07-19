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

function stripTsComments(source: string): string {
  const chars = [...source];
  let index = 0;
  let quote: '"' | "'" | '`' | null = null;
  while (index < chars.length) {
    const char = chars[index];
    const following = chars[index + 1];
    if (quote !== null) {
      if (char === '\\') {
        index += 2;
        continue;
      }
      if (char === quote) quote = null;
      index += 1;
      continue;
    }
    if (char === '"' || char === "'" || char === '`') {
      quote = char;
      index += 1;
      continue;
    }
    if (char === '/' && following === '/') {
      while (index < chars.length && chars[index] !== '\n' && chars[index] !== '\r') {
        chars[index] = ' ';
        index += 1;
      }
      continue;
    }
    if (char === '/' && following === '*') {
      chars[index] = chars[index + 1] = ' ';
      index += 2;
      while (index < chars.length) {
        if (chars[index] === '*' && chars[index + 1] === '/') {
          chars[index] = chars[index + 1] = ' ';
          index += 2;
          break;
        }
        if (chars[index] !== '\n' && chars[index] !== '\r') chars[index] = ' ';
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

function extractPythonStatuses(source: string, sourcePath: string): string[] {
  source = stripPythonNonCode(source);
  const matches = [
    ...source.matchAll(
      /^[ \t]*if[ \t]+parsed\.get\("status"\)[ \t]+not[ \t]+in[ \t]+\(([^)]*)\)[ \t]*:/gm,
    ),
  ];
  if (matches.length === 0) {
    throw new Error(`could not locate the status guard tuple in ${sourcePath} — declaration moved?`);
  }
  if (matches.length !== 1) {
    throw new Error(
      `expected exactly one status guard tuple in ${sourcePath}, found ${matches.length} declaration-shaped matches`,
    );
  }
  const match = matches[0];
  const body = match[1];
  if (!/^[ \t\r\n]*"[^"\r\n]+"(?:[ \t\r\n]*,[ \t\r\n]*"[^"\r\n]+")*[ \t\r\n]*,?[ \t\r\n]*$/u.test(body)) {
    throw new Error(`unsupported syntax in status guard tuple in ${sourcePath}: ${body}`);
  }
  return [...body.matchAll(/"([^"]+)"/g)].map((member) => member[1]).sort();
}

function extractTsStatuses(source: string, sourcePath: string): string[] {
  source = stripTsComments(source);
  const matches = [
    ...source.matchAll(
      /^export[ \t]+type[ \t]+ProcessStatus[ \t]*=[ \t]*([^;]+);/gm,
    ),
  ];
  if (matches.length === 0) {
    throw new Error(`could not locate the ProcessStatus union in ${sourcePath} — declaration moved?`);
  }
  if (matches.length !== 1) {
    throw new Error(
      `expected exactly one ProcessStatus union in ${sourcePath}, found ${matches.length} declaration-shaped matches`,
    );
  }
  const match = matches[0];
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

  it('rejects a Python docstring decoy before the live status guard', () => {
    const source = `"""
if parsed.get("status") not in ("ok", "degraded", "unavailable"):
"""
if parsed.get("status") not in ("ok", EXTRA_STATUS):`;

    expect(() => extractPythonStatuses(source, 'fixture-jinn-layer.py')).toThrow(
      /status guard tuple.*fixture-jinn-layer\.py/,
    );
  });

  it('rejects a sole Python docstring status decoy', () => {
    const source = `"""
if parsed.get("status") not in ("ok", "degraded"):
"""
allowed_statuses = ("ok", "degraded", "unavailable")
if parsed.get("status") not in allowed_statuses:
    pass`;

    expect(() => extractPythonStatuses(source, 'fixture-jinn-layer.py')).toThrow(
      /status guard tuple.*fixture-jinn-layer\.py/,
    );
  });

  it('rejects a sole Python line-comment status decoy', () => {
    const source = `# if parsed.get("status") not in ("ok", "degraded"):
allowed_statuses = ("ok", "degraded", "unavailable")
if parsed.get("status") not in allowed_statuses:
    pass`;

    expect(() => extractPythonStatuses(source, 'fixture-jinn-layer.py')).toThrow(
      /status guard tuple.*fixture-jinn-layer\.py/,
    );
  });

  it('rejects a TypeScript block-comment decoy before the live ProcessStatus union', () => {
    const source = `/*
export type ProcessStatus = 'ok' | 'degraded' | 'unavailable';
*/
export type ProcessStatus = 'ok' | ExtraStatus;`;

    expect(() => extractTsStatuses(source, 'fixture-process-contract.ts')).toThrow(
      /ProcessStatus union.*fixture-process-contract\.ts/,
    );
  });

  it('rejects a sole TypeScript block-comment status decoy', () => {
    const source = `/*
export type ProcessStatus = 'ok' | 'degraded';
*/
export { type ProcessStatus } from './shared-process-status.js';`;

    expect(() => extractTsStatuses(source, 'fixture-process-contract.ts')).toThrow(
      /ProcessStatus union.*fixture-process-contract\.ts/,
    );
  });

  it('rejects a sole TypeScript line-comment status decoy', () => {
    const source = `// export type ProcessStatus = 'ok' | 'degraded';
export { type ProcessStatus } from './shared-process-status.js';`;

    expect(() => extractTsStatuses(source, 'fixture-process-contract.ts')).toThrow(
      /ProcessStatus union.*fixture-process-contract\.ts/,
    );
  });

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

  // PROCESS_CONTRACT_VERSION is a re-export of the plugin package's
  // JINN_PLUGIN_CONTRACT_VERSION, so this assertion is structurally the same
  // check as packages/plugin/test/contract-parity.test.ts — it exists so the
  // client CI path (plain `yarn test`) also gates the cross-language pin.
  it('Python CONTRACT_VERSION matches PROCESS_CONTRACT_VERSION', () => {
    const source = readFileSync(PY_JINN_LAYER, 'utf8');
    const pyVersion = extractPythonVersion(source, PY_JINN_LAYER);
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
