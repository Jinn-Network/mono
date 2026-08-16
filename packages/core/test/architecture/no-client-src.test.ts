import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join, normalize, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SPECIFIER, tsFiles } from './import-scan.js';

/**
 * Core's headline invariant (#1833, spec §4.3.2): `packages/core/src` must
 * have ZERO imports resolving into `operator/src`. Core is the domain package
 * that sits BELOW the daemon; any relative escape into `operator/src` inverts
 * the dependency arrow and is forbidden. From `packages/core`, `operator/src`
 * is `../../operator/src`.
 */
const pkgRoot = fileURLToPath(new URL('../../', import.meta.url));
const clientSrc = normalize(join(pkgRoot, '..', '..', 'operator', 'src'));

function relativeSpecifiers(source: string): string[] {
  const specs: string[] = [];
  for (const match of source.matchAll(SPECIFIER)) {
    if (match[1].startsWith('.')) specs.push(match[1]);
  }
  return specs;
}

function posix(p: string): string {
  return p.split(sep).join('/');
}

describe('core ↛ operator/src (#1833)', () => {
  it('no import in core/src resolves into operator/src', () => {
    const escapes: string[] = [];
    for (const file of tsFiles(join(pkgRoot, 'src'))) {
      const source = readFileSync(file, 'utf-8');
      for (const spec of relativeSpecifiers(source)) {
        const resolved = normalize(join(dirname(file), spec));
        if (resolved === clientSrc || resolved.startsWith(clientSrc + sep)) {
          escapes.push(`${posix(relative(pkgRoot, file))} -> ${spec}`);
        }
      }
    }
    expect(
      escapes.sort(),
      `core/src imports escaping into operator/src (forbidden — core is below the daemon):\n${escapes.join('\n')}`,
    ).toEqual([]);
  });
});
