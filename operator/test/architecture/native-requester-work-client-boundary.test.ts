import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * `operator/src/native-requester/work-client/` is the extractable work-client module — the
 * marketplace-surfaces hand-off seam (cutover stage-3 posting-flow plan §Architecture,
 * DR-2026-08-05 decision 1 "names-as-landed"). It is composed strictly through the binding's
 * public interfaces and injected ports, so it must not import anything from the rest of the
 * host. This test is what makes "extractable" a *checked* property rather than a hope.
 *
 * The sibling `native-requester/requester.ts` / `requester-source-writer-adapter.ts` are the
 * pre-existing host-composed requester orchestrator (discovery-decode coupled); they are
 * deliberately NOT part of the extractable seam and are not scanned here.
 */
const workClientDir = fileURLToPath(new URL('../../src/native-requester/work-client/', import.meta.url));

/** Bare specifiers the module may depend on. Anything else is a boundary violation. */
const ALLOWED_PACKAGES = [
  '@jinn-network/marketplace-binding',
  '@jinn-network/task-execution-protocol',
  '@jinn-network/task-execution-profiles',
  '@jinn-network/task-execution-backend',
  'viem',
  'zod',
];

const IMPORT_RE = /(?:from|import)\s+['"]([^'"]+)['"]/g;

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) return sourceFiles(full);
    return name.endsWith('.ts') ? [full] : [];
  });
}

describe('src/native-requester/work-client/ import boundary', () => {
  it('the module exists and has source files', () => {
    expect(sourceFiles(workClientDir).length).toBeGreaterThan(0);
  });

  it('no module under work-client/ imports outside the module', () => {
    const offenders: string[] = [];
    for (const file of sourceFiles(workClientDir)) {
      const src = readFileSync(file, 'utf-8');
      for (const match of src.matchAll(IMPORT_RE)) {
        const specifier = match[1]!;
        if (specifier.startsWith('node:')) continue;
        if (!specifier.startsWith('.')) {
          const root = specifier.startsWith('@')
            ? specifier.split('/').slice(0, 2).join('/')
            : specifier.split('/')[0]!;
          if (!ALLOWED_PACKAGES.includes(root)) {
            offenders.push(`${relative(workClientDir, file)}: bare import ${specifier}`);
          }
          continue;
        }
        const resolved = resolve(dirname(file), specifier);
        if (relative(workClientDir, resolved).startsWith('..')) {
          offenders.push(`${relative(workClientDir, file)}: escapes the module via ${specifier}`);
        }
      }
    }
    expect(offenders, `work-client boundary violations:\n${offenders.join('\n')}`).toEqual([]);
  });
});
