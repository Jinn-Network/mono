/**
 * The `check-no-error-leak` guard's own behaviour (issue #2416 AC3).
 *
 * #2402 introduced the guard but scoped it by viem/`PublicClient` imports, so
 * it saw none of the token-gated routes this issue fixes — those reach the RPC
 * only through an injected reader. #2416 makes each `rpc/transport.ts` masking
 * helper a file-scope trigger too, which is what pulls those files in. These
 * tests pin both halves of that: a file importing a choke point is in scope,
 * and a call through any of the three helpers counts as fixed.
 */
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { ErrorLeakViolation } from '../../scripts/check-no-error-leak.mjs';
import {
  findErrorLeaks,
  findGraphCompletenessGaps,
  findRawHitCompletenessGaps,
  isRpcAdjacent,
  moduleTouchesViem,
  parseRelativeImportSpecs,
} from '../../scripts/check-no-error-leak.mjs';

const LIVE_SRC = join(dirname(fileURLToPath(import.meta.url)), '../../src');
const LIVE_API = join(LIVE_SRC, 'api');

/**
 * Build a throwaway `src/api` tree and scan it.
 *
 * The return type is named rather than inferred so the guard's declared
 * contract is stated at the point of use: a later change to what
 * `check-no-error-leak.d.mts` exports fails here instead of quietly reshaping
 * every assertion below.
 */
function scan(files: Record<string, string>): ErrorLeakViolation[] {
  const srcRoot = mkdtempSync(join(tmpdir(), 'jinn-leak-guard-'));
  const apiDir = join(srcRoot, 'api');
  mkdirSync(apiDir, { recursive: true });
  for (const [name, body] of Object.entries(files)) writeFileSync(join(apiDir, name), body);
  return findErrorLeaks(apiDir, srcRoot);
}

const RAW = 'return c.json({ detail: err instanceof Error ? err.message : String(err) });';

describe('check-no-error-leak guard', () => {
  it.each(['maskUrlsInMessage', 'sanitizeErrorText', 'sanitizePersistedText'])(
    'brings a file importing %s into scope',
    (helper) => {
      const violations = scan({
        'x.ts': `import { ${helper} } from '../rpc/transport.js';\n${RAW}\n`,
      });
      expect(violations).toHaveLength(1);
      expect(violations[0]?.file).toBe('operator/src/api/x.ts');
    },
  );

  it.each(['maskUrlsInMessage', 'sanitizeErrorText', 'sanitizePersistedText'])(
    'accepts a conversion routed through %s',
    (helper) => {
      expect(
        scan({
          'x.ts':
            `import { ${helper} } from '../rpc/transport.js';\n` +
            `return c.json({ detail: ${helper}(err) });\n`,
        }),
      ).toEqual([]);
    },
  );

  /**
   * The regression this guard exists to catch. Scoping the token-gated routes
   * by the masking helper alone would be circular — reverting the fix would
   * also revert the file out of scope. Each of these is the PRE-fix shape of a
   * file #2416 repaired, and each must be flagged on its own imports.
   */
  it.each([
    ['discovery-endpoint (injected reader)', "import type { PluginPublicationReader } from '../plugin-registry/publication-reader.js';"],
    ['discovery-endpoint (archive reads)', "import type { ArchiveReads } from '../archive/reads.js';"],
    ['rewards-endpoint', "import { gatherGatheredStatusRaw } from './gather-status.js';"],
    ['admin-endpoint', "import { claimRewardsIntent } from '../intents/claim-rewards.js';"],
  ])('flags the pre-fix %s shape, with no masking import present', (_label, importLine) => {
    const violations = scan({ 'x.ts': `${importLine}\n${RAW}\n` });
    expect(violations).toHaveLength(1);
  });

  it('requires a call, not a mention, to treat a line as fixed', () => {
    expect(
      scan({
        'x.ts':
          "import { sanitizeErrorText } from '../rpc/transport.js';\n" +
          `${RAW} // masked by sanitizeErrorText upstream\n`,
      }),
    ).toHaveLength(1);
  });

  it('still flags a raw conversion in a viem-importing file', () => {
    expect(scan({ 'x.ts': `import { createPublicClient } from 'viem';\n${RAW}\n` })).toHaveLength(1);
  });

  it('leaves a file with no RPC adjacency out of scope', () => {
    expect(scan({ 'x.ts': `import { z } from 'zod';\n${RAW}\n` })).toEqual([]);
  });

  it('honours the inline allow marker', () => {
    expect(
      scan({
        'x.ts': `import { maskUrlsInMessage } from '../rpc/transport.js';\n${RAW} // lint:no-error-leak-allow\n`,
      }),
    ).toEqual([]);
  });
});

function writeTree(files: Record<string, string>): { srcRoot: string; files: Record<string, string> } {
  const srcRoot = mkdtempSync(join(tmpdir(), 'jinn-leak-graph-'));
  const abs: Record<string, string> = {};
  for (const [rel, body] of Object.entries(files)) {
    const path = join(srcRoot, rel);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, body);
    abs[rel] = path;
  }
  return { srcRoot, files: abs };
}

describe('check-no-error-leak relative-import graph', () => {
  it('parses only ./ and ../ specs', () => {
    expect(
      parseRelativeImportSpecs(
        "import { a } from './local.js';\nimport { b } from '../up.js';\nimport { c } from 'viem';\nimport { d } from 'hono';\n",
      ),
    ).toEqual(['./local.js', '../up.js']);
  });

  it('moduleTouchesViem follows a relative import to a viem importer', () => {
    const { srcRoot, files } = writeTree({
      'api/route.ts': "import { gather } from './helper.js';\n",
      'api/helper.ts': "import { createPublicClient } from 'viem';\n",
    });
    expect(moduleTouchesViem(files['api/route.ts']!, srcRoot)).toBe(true);
    expect(moduleTouchesViem(files['api/helper.ts']!, srcRoot)).toBe(true);
  });

  it('moduleTouchesViem does not escape srcRoot or follow a cycle as true', () => {
    const { srcRoot, files } = writeTree({
      'api/a.ts': "import { b } from './b.js';\n",
      'api/b.ts': "import { a } from './a.js';\n",
    });
    expect(moduleTouchesViem(files['api/a.ts']!, srcRoot)).toBe(false);
  });

  it('counts a one-hop outside-api file that itself imports viem', () => {
    const { srcRoot, files } = writeTree({
      'api/rewards.ts': "import { claim } from '../intents/claim-rewards.js';\n",
      'intents/claim-rewards.ts': "import { createPublicClient } from 'viem';\n",
    });
    expect(moduleTouchesViem(files['api/rewards.ts']!, srcRoot)).toBe(true);
  });

  it('does not treat a one-hop viem/accounts import as graph-adjacent', () => {
    const { srcRoot, files } = writeTree({
      'api/doctor.ts': "import { load } from '../harnesses/api-wallet.js';\n",
      'harnesses/api-wallet.ts': "import { privateKeyToAccount } from 'viem/accounts';\n",
    });
    expect(moduleTouchesViem(files['api/doctor.ts']!, srcRoot)).toBe(false);
  });

  it('does not recurse past one hop outside api/', () => {
    const { srcRoot, files } = writeTree({
      'api/events.ts': "import { Store } from '../store/store.js';\n",
      'store/store.ts': "import { client } from '../rpc/client.js';\n",
      'rpc/client.ts': "import { createPublicClient } from 'viem';\n",
    });
    expect(moduleTouchesViem(files['api/events.ts']!, srcRoot)).toBe(false);
  });

  it('names a graph-adjacent file that is not isRpcAdjacent', () => {
    const { srcRoot } = writeTree({
      'api/route.ts': "import { gather } from './helper.js';\nconst x = err instanceof Error ? err.message : String(err);\n",
      'api/helper.ts': "import { createPublicClient } from 'viem';\n",
    });
    const gaps = findGraphCompletenessGaps(join(srcRoot, 'api'), srcRoot);
    expect(gaps).toContain('operator/src/api/route.ts');
    expect(isRpcAdjacent("import { gather } from './helper.js';\n")).toBe(false);
  });

  it('live api/ tree: every graph-adjacent file is already isRpcAdjacent', () => {
    expect(findGraphCompletenessGaps(LIVE_API, LIVE_SRC)).toEqual([]);
  });

  it('still flags live seam files after stripping sanitizeErrorText', () => {
    const names = ['discovery-endpoint.ts', 'rewards-endpoint.ts', 'admin-endpoint.ts'] as const;
    const srcRoot = mkdtempSync(join(tmpdir(), 'jinn-leak-strip-'));
    const apiDir = join(srcRoot, 'api');
    mkdirSync(apiDir, { recursive: true });
    for (const name of names) {
      const live = readFileSync(join(LIVE_API, name), 'utf8');
      const stripped = live
        .replace(/import\s*\{[^}]*sanitizeErrorText[^}]*\}\s*from\s*['"][^'"]+['"];\s*/g, '')
        .replace(/sanitizeErrorText\(([^)]+)\)/g, '($1 instanceof Error ? $1.message : String($1))');
      expect(stripped).not.toMatch(/sanitizeErrorText\s*\(/);
      expect(stripped).not.toMatch(/import\s*\{[^}]*sanitizeErrorText/);
      writeFileSync(join(apiDir, name), stripped);
    }
    const violations = findErrorLeaks(apiDir, srcRoot);
    const flagged = new Set(violations.map((v) => v.file.split('/').pop()));
    for (const name of names) {
      expect(flagged.has(name), `expected seam import to keep ${name} in scope`).toBe(true);
    }
  });
});

/**
 * The regression this backstop exists to catch (issue #4246 review of
 * PR #4663): a route that reaches an RPC client only through an injected
 * port has no import edge to `viem` for the graph check to follow, so it
 * is invisible to `findGraphCompletenessGaps` too. A raw conversion in such
 * a file must fail the guard, not pass silently, until a human either fixes
 * it or names it on `NON_RPC_API_ALLOWLIST` with a reason.
 */
describe('check-no-error-leak raw-hit completeness (issue #4246)', () => {
  function scanRawHitTree(files: Record<string, string>) {
    const srcRoot = mkdtempSync(join(tmpdir(), 'jinn-leak-rawhit-'));
    const apiDir = join(srcRoot, 'api');
    mkdirSync(apiDir, { recursive: true });
    for (const [name, body] of Object.entries(files)) writeFileSync(join(apiDir, name), body);
    return findRawHitCompletenessGaps(apiDir, srcRoot);
  }

  it('fails on a synthetic injected-port file with a raw hit and no allowlist entry', () => {
    const gaps = scanRawHitTree({
      // No viem import (not isRpcAdjacent) and no NON_RPC_API_ALLOWLIST
      // entry for this filename — the exact shape the guard used to miss.
      'new-injected-reader-endpoint.ts':
        "import type { SomeInjectedReader } from '../some-module/reader.js';\n" + RAW,
    });
    expect(gaps).toEqual(['operator/src/api/new-injected-reader-endpoint.ts']);
  });

  it('leaves a file with no raw hit alone', () => {
    expect(scanRawHitTree({ 'clean.ts': 'export const x = 1;\n' })).toEqual([]);
  });

  it('leaves an isRpcAdjacent file alone (findErrorLeaks already covers it)', () => {
    expect(
      scanRawHitTree({ 'viem-route.ts': "import { createPublicClient } from 'viem';\n" + RAW }),
    ).toEqual([]);
  });

  it('leaves a file named on NON_RPC_API_ALLOWLIST alone', () => {
    // Same basename as a live, human-verified allowlist entry.
    expect(scanRawHitTree({ 'stop-hook.ts': RAW })).toEqual([]);
  });

  it('live api/ tree: every raw hit is isRpcAdjacent or on the allowlist', () => {
    expect(findRawHitCompletenessGaps(LIVE_API, LIVE_SRC)).toEqual([]);
  });
});
