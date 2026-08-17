import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Architecture boundary test for #2412 (spec §4.1 intent-module law, arriving
 * early per §8 artifact 5 rather than waiting for stage 6).
 *
 * A control route is a thin front-end over a pure intent module — it must
 * never construct or invoke a CLI `CommandModule` (that was exactly the
 * `POST /api/admin/claim-rewards` bug: the route ran `cli/commands/claim-rewards.js`
 * in-process via a fabricated `CommandContext`, which tripped the CLI-only
 * daemon-guard). This test scans the source text of every module under
 * `src/api/` (recursively) and fails if any import specifier resolves into
 * `cli/commands/`.
 */
const apiDir = fileURLToPath(new URL('../../src/api/', import.meta.url));

function apiSourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      out.push(...apiSourceFiles(full));
    } else if (name.endsWith('.ts')) {
      out.push(full);
    }
  }
  return out;
}

// Matches import specifiers that resolve into a `cli/commands/` path segment.
const FORBIDDEN = /from\s+['"][^'"]*\/cli\/commands\/[^'"]*['"]/;

describe('api → cli/commands boundary (#2412)', () => {
  it('no module under src/api/ imports from cli/commands/', () => {
    const offenders: string[] = [];
    for (const file of apiSourceFiles(apiDir)) {
      const src = readFileSync(file, 'utf-8');
      for (const line of src.split('\n')) {
        if (FORBIDDEN.test(line)) {
          offenders.push(`${file.split('/api/')[1]}: ${line.trim()}`);
        }
      }
    }
    expect(offenders, `forbidden api→cli/commands imports:\n${offenders.join('\n')}`).toEqual([]);
  });

  it('claim-policy PUT handlers import write intents, not CLI modules', () => {
    const src = readFileSync(join(apiDir, 'claim-policy-endpoints.ts'), 'utf-8');
    expect(src).toMatch(/writeClaimPolicyIntent/);
    expect(src).toMatch(/writeExecutionWiringIntent/);
    expect(src).toMatch(/from ['"][^'"]*intents\/claim-policy-write/);
    expect(src).toMatch(/from ['"][^'"]*intents\/execution-wiring-write/);
    expect(src).not.toMatch(FORBIDDEN);
  });
});
