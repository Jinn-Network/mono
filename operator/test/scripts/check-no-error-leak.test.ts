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
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { findErrorLeaks } from '../../scripts/check-no-error-leak.mjs';

/** Build a throwaway `src/api` tree and scan it. */
function scan(files: Record<string, string>) {
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
