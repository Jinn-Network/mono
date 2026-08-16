import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SPECIFIER, tsFiles } from './import-scan.js';

/**
 * Core forbidden-import boundary (#1833/#1836, spec §4.3.2). Core owns
 * read-side domain mechanics, but MUST NOT reach for the client package,
 * wallet/chain-write, or MCP surfaces.
 */
const pkgRoot = fileURLToPath(new URL('../../', import.meta.url));
const srcDir = join(pkgRoot, 'src');

/** Bare/relative specifiers matching a forbidden package or surface. */
const FORBIDDEN = [
  /^viem($|\/)/,
  /^@jinn-network\/client($|\/)/,
  /^@modelcontextprotocol\/sdk($|\/)/,
  /operator\/src/,
  /wallet/i,
];

function posix(p: string): string {
  return p.split(sep).join('/');
}

describe('core forbidden imports (#1833)', () => {
  it('has no client / viem / wallet / MCP-sdk / chain-write imports', () => {
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
