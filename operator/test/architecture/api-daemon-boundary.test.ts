import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Architecture boundary test for #1584.
 *
 * The API layer (`operator/src/api/`) must not depend inward on the daemon
 * layer (`operator/src/daemon/`) nor on retired task-run persistence internals.
 * The API consumes neutral ports/types (`types/`, `spend/`, `store/` — the
 * read-model port, not a concrete persistence class; see
 * `types/task-run-read-model.ts`) instead. This test scans the source text
 * of every module under `src/api/` and fails if any of those forbidden
 * import specifiers are present.
 */
const apiDir = fileURLToPath(new URL('../../src/api/', import.meta.url));

function apiSourceFiles(): string[] {
  return readdirSync(apiDir)
    .filter((name) => name.endsWith('.ts'))
    .map((name) => join(apiDir, name));
}

// Matches import specifiers that resolve into `operator/src/daemon/` — i.e. a
// `/daemon/` path segment in a relative specifier — or that end in the
// task-run persistence module. Both the post-relocation home
// (`store/task-run-persistence`, one-swap P0-1) and the surviving
// `harnesses/engine/persistence` shim are named, so the boundary holds
// whichever path an offending import spells. The `/daemon/` segment guard
// deliberately excludes `solvernets/daemon-init` (that lives under
// `solvernets/`, not `daemon/`).
const FORBIDDEN =
  /from\s+['"][^'"]*\/daemon\/[^'"]*['"]|from\s+['"][^'"]*harnesses\/engine\/persistence(?:\.js)?['"]|from\s+['"][^'"]*task-run-persistence(?:\.js)?['"]/;

describe('api → daemon boundary (#1584)', () => {
  it('no module under src/api/ imports from daemon/ or engine/persistence', () => {
    const offenders: string[] = [];
    for (const file of apiSourceFiles()) {
      const src = readFileSync(file, 'utf-8');
      for (const line of src.split('\n')) {
        if (FORBIDDEN.test(line)) {
          offenders.push(`${file.split('/api/')[1]}: ${line.trim()}`);
        }
      }
    }
    expect(offenders, `forbidden api→daemon/persistence imports:\n${offenders.join('\n')}`).toEqual([]);
  });
});
