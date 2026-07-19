import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SPECIFIER, tsFiles } from './import-scan.js';

/**
 * Core forbidden-import boundary (#1833, spec §4.3.2). Core is a pure domain
 * package: stores + schemas. It MUST NOT reach for wallet/chain-write or MCP
 * surfaces. Any `viem`, wallet, `@modelcontextprotocol/sdk`, or chain-write
 * specifier in `core/src` is a boundary violation.
 */
const pkgRoot = fileURLToPath(new URL('../../', import.meta.url));
const srcDir = join(pkgRoot, 'src');

/** Bare/relative specifiers matching a forbidden package or surface. */
const FORBIDDEN = [
  /^viem($|\/)/,
  /^@modelcontextprotocol\/sdk($|\/)/,
  /wallet/i,
];

function posix(p: string): string {
  return p.split(sep).join('/');
}

describe('core forbidden imports (#1833)', () => {
  it('no viem / wallet / MCP-sdk / chain-write import appears in core/src', () => {
    const offenders: string[] = [];
    for (const file of tsFiles(srcDir)) {
      const source = readFileSync(file, 'utf-8');
      for (const match of source.matchAll(SPECIFIER)) {
        const spec = match[1];
        if (FORBIDDEN.some((re) => re.test(spec))) {
          offenders.push(`${posix(relative(pkgRoot, file))} -> ${spec}`);
        }
      }
    }
    expect(
      offenders.sort(),
      `forbidden imports in core/src (wallet / chain-write / MCP are out of core's scope):\n${offenders.join('\n')}`,
    ).toEqual([]);
  });
});
