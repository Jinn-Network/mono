/**
 * Wave-4 D4 (DR-2026-08-05 addendum 2026-08-13, cutover stage-4 plan Tasks 9–14
 * as amended by R3a/R3b and #2494): `client/src/discovery/` and the peer-sync
 * loop retire. Native replacements (public archive listener, M6 discovery
 * serving, R3a `plugin-registry/`, R3b `discovery-client/`) already shipped.
 *
 * D6 owns `LOOP_REGISTRY` narrowing — the `peer-sync` row stays declared.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { LOOP_REGISTRY } from '../../src/daemon/loop-heartbeat.js';
import { codeOnly } from './_support/source-text.js';

const srcRoot = fileURLToPath(new URL('../../src/', import.meta.url));

function source(relative: string): string {
  return codeOnly(readFileSync(join(srcRoot, relative), 'utf8'));
}

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      return entry.name === 'node_modules' || entry.name === 'dist' ? [] : sourceFiles(path);
    }
    return /\.tsx?$/u.test(entry.name) && !/\.test\.tsx?$/u.test(entry.name) ? [path] : [];
  });
}

/** Specifier names the retired `src/discovery/` tree, not `discovery-client/`. */
function isRetiredDiscoverySpecifier(specifier: string): boolean {
  return /(^|\/)discovery(?!-client)\//u.test(specifier);
}

function importsRetiredDiscoveryTree(text: string): boolean {
  return [...text.matchAll(/(?:import|export)\s+(?:type\s+)?[\s\S]*?\s+from\s*['"]([^'"]+)['"]/gu)]
    .concat([...text.matchAll(/\bimport\(\s*['"]([^'"]+)['"]\s*\)/gu)])
    .some((match) => isRetiredDiscoverySpecifier(match[1]!));
}

describe('client/src/discovery and peer-sync are retired (Wave-4 D4)', () => {
  it('the discovery tree is gone', () => {
    expect(existsSync(join(srcRoot, 'discovery'))).toBe(false);
  });

  it('production src has no value-import of discovery/', () => {
    const offenders = sourceFiles(srcRoot)
      .map((path) => path.slice(srcRoot.length))
      .filter((path) => importsRetiredDiscoveryTree(codeOnly(readFileSync(join(srcRoot, path), 'utf8'))));
    expect(offenders).toEqual([]);
  });

  it('the import scanner is non-vacuous', () => {
    // Negative control: a real value-import of the retired tree MUST match.
    // `discovery-client/` is the keep-module and must NOT match, or the
    // production scan above is a tautology.
    expect(
      importsRetiredDiscoveryTree(
        codeOnly("import { DiscoveryAPI } from '../discovery/types.js';\nconst ready = true;\n"),
      ),
    ).toBe(true);
    expect(
      importsRetiredDiscoveryTree(
        codeOnly("import { createHttpDiscoveryClient } from '../discovery-client/http.js';\n"),
      ),
    ).toBe(false);
    expect(isRetiredDiscoverySpecifier('../discovery/http.js')).toBe(true);
    expect(isRetiredDiscoverySpecifier('../discovery-client/http.js')).toBe(false);
  });

  it('Daemon.start never constructs PeerSync or starts peer-sync', () => {
    const daemon = source('daemon/daemon.ts');
    expect(daemon).not.toMatch(/\bPeerSync\b/u);
    expect(daemon).not.toMatch(/started\.add\(\s*['"]peer-sync['"]\s*\)/u);
    expect(existsSync(join(srcRoot, 'daemon/peer-sync.ts'))).toBe(false);
  });

  it('plugin routes do not call getDiscovery()', () => {
    const routes = source('api/discovery-endpoint.ts');
    expect(routes).not.toMatch(/\bgetDiscovery\s*\(/u);
  });

  it('keeps discovery-client, plugin-registry, and the peer-sync registry row', () => {
    expect(existsSync(join(srcRoot, 'discovery-client'))).toBe(true);
    expect(existsSync(join(srcRoot, 'plugin-registry'))).toBe(true);
    expect(LOOP_REGISTRY.map((row) => row.name)).toContain('peer-sync');
  });
});
