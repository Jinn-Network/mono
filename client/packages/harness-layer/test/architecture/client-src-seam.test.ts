import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join, normalize, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SPECIFIER, tsFiles } from './import-scan.js';

/**
 * Boundary tests for the harness-layer ↔ client/src seam (#1832).
 *
 * Forward direction: harness-layer legitimately imports client/src today. The
 * inventory below is the frozen allowlist of every (source file, import
 * specifier) pair that crosses the seam. It MAY ONLY SHRINK — it is the
 * work-list for the C5 extraction. Adding a new client/src import to
 * harness-layer fails this test; removing one requires pruning the matching
 * inventory line so the list stays an accurate record of what remains.
 *
 * Reverse direction: client/src must not reference harness-layer at all. The
 * former mineable-store → dist/harness-layer/contribution-store.js reference
 * was removed in C2 (#1833) when the contribution store moved to
 * @jinn-network/core; the daemon now imports the bare core specifier. Any new
 * client/src → harness-layer reference fails.
 */
const pkgRoot = fileURLToPath(new URL('../../', import.meta.url));
const clientRoot = normalize(join(pkgRoot, '..', '..'));

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

// The frozen allowlist: every import from packages/harness-layer/src into
// client/src as of #1832. Shrink-only — see the header comment.
const CLIENT_SRC_IMPORT_INVENTORY = [
  'src/adapters/corpus-adapter.ts -> ../../../../src/types/skill-artifact.js',
  'src/bridge.ts -> ../../../src/trajectory/scrub/layer2.js',
  'src/bridge.ts -> ../../../src/trajectory/scrub/pipeline.js',
  'src/capture.ts -> ../../../src/trajectory/scrub/build.js',
  'src/capture.ts -> ../../../src/trajectory/scrub/emit-scrub.js',
  'src/capture.ts -> ../../../src/trajectory/scrub/key-policy.js',
  'src/capture.ts -> ../../../src/trajectory/scrub/ml-pii-stage.js',
  'src/capture.ts -> ../../../src/trajectory/scrub/pipeline.js',
  'src/capture.ts -> ../../../src/trajectory/scrub/types.js',
  'src/cli.ts -> ../../../src/cli/password.js',
  'src/cli.ts -> ../../../src/config.js',
  'src/cli.ts -> ../../../src/earning/store.js',
  'src/cli.ts -> ../../../src/earning/types.js',
  'src/cli.ts -> ../../../src/earning/wallet.js',
  'src/cli.ts -> ../../../src/solver-types/_swe-rebench-v2-held-out-slate.js',
  'src/cli.ts -> ../../../src/util/path-safety.js',
  'src/consume.ts -> ../../../src/config.js',
  'src/consume.ts -> ../../../src/corpus/fetch-artifact.js',
  'src/consume.ts -> ../../../src/corpus/index.js',
  'src/consume.ts -> ../../../src/corpus/types.js',
  'src/consume.ts -> ../../../src/discovery/factory.js',
  'src/consume.ts -> ../../../src/discovery/types.js',
  'src/consume.ts -> ../../../src/store/store.js',
  'src/consume.ts -> ../../../src/types/envelope.js',
  'src/consume.ts -> ../../../src/types/skill-artifact.js',
  'src/distill.ts -> ../../../src/trajectory/scrub/layer2.js',
  'src/distill.ts -> ../../../src/trajectory/scrub/pipeline.js',
  'src/distiller.ts -> ../../../src/trajectory/scrub/layer2.js',
  'src/distiller.ts -> ../../../src/trajectory/scrub/pipeline.js',
  'src/index.ts -> ../../../src/types/skill-artifact.js',
  'src/measurement.ts -> ../../../src/eval/paired.js',
  'src/pipeline.ts -> ../../../src/trajectory/scrub/layer2.js',
  'src/publish-live.ts -> ../../../src/adapters/mech/ipfs.js',
  'src/publish-live.ts -> ../../../src/adapters/mech/safe.js',
  'src/publish-live.ts -> ../../../src/captures/publish.js',
  'src/publish-live.ts -> ../../../src/erc8004/index.js',
  'src/publish-live.ts -> ../../../src/harnesses/engine/canonical-json.js',
  'src/publish-skill.ts -> ../../../src/captures/publish.js',
  'src/publish-skill.ts -> ../../../src/harnesses/engine/canonical-json.js',
  'src/publish-skill.ts -> ../../../src/harnesses/engine/signing.js',
  'src/publish-skill.ts -> ../../../src/store/captures.js',
  'src/publish-skill.ts -> ../../../src/trajectory/schema.js',
  'src/publish-skill.ts -> ../../../src/types/envelope.js',
  'src/publish-skill.ts -> ../../../src/types/skill-artifact.js',
  'src/publish.ts -> ../../../src/captures/publish.js',
  'src/publish.ts -> ../../../src/harnesses/engine/canonical-json.js',
  'src/publish.ts -> ../../../src/harnesses/engine/signing.js',
  'src/publish.ts -> ../../../src/store/captures.js',
  'src/publish.ts -> ../../../src/trajectory/schema.js',
  'src/publish.ts -> ../../../src/types/envelope.js',
  'src/publish.ts -> ../../../src/types/skill-artifact.js',
  'src/seed-import/episode-execute.ts -> ../../../../src/trajectory/scrub/build.js',
  'src/seed-import/episode-execute.ts -> ../../../../src/trajectory/scrub/types.js',
  'src/seed-import/execute.ts -> ../../../../src/trajectory/scrub/build.js',
  'src/seed-import/execute.ts -> ../../../../src/types/skill-artifact.js',
  'src/seed-import/state.ts -> ../../../../src/captures/publish.js',
  'src/seed-import/state.ts -> ../../../../src/harnesses/engine/canonical-json.js',
  'src/skill-package.ts -> ../../../src/types/skill-artifact.js',
  'src/skill.ts -> ../../../src/types/skill-artifact.js',
];

describe('harness-layer ↔ client/src seam (#1832)', () => {
  it('harness-layer imports into client/src stay within the frozen inventory (shrink-only)', () => {
    const clientSrc = join(clientRoot, 'src');
    const found = new Set<string>();
    for (const file of tsFiles(join(pkgRoot, 'src'))) {
      const source = readFileSync(file, 'utf-8');
      for (const spec of relativeSpecifiers(source)) {
        const resolved = normalize(join(dirname(file), spec));
        if (resolved.startsWith(clientSrc + sep)) {
          found.add(`${posix(relative(pkgRoot, file))} -> ${spec}`);
        }
      }
    }
    const inventory = new Set(CLIENT_SRC_IMPORT_INVENTORY);

    const newEscapes = [...found].filter((pair) => !inventory.has(pair)).sort();
    expect(
      newEscapes,
      `new harness-layer → client/src imports (the seam may only shrink):\n${newEscapes.join('\n')}`,
    ).toEqual([]);

    const stale = [...inventory].filter((pair) => !found.has(pair)).sort();
    expect(
      stale,
      `inventory entries no longer imported — prune them (shrink the C5 work-list):\n${stale.join('\n')}`,
    ).toEqual([]);
  });

  it('client/src has no references into harness-layer', () => {
    const found: string[] = [];
    for (const file of tsFiles(join(clientRoot, 'src'))) {
      const source = readFileSync(file, 'utf-8');
      for (const match of source.matchAll(SPECIFIER)) {
        if (match[1].includes('harness-layer')) {
          found.push(`${posix(relative(clientRoot, file))} -> ${match[1]}`);
        }
      }
    }
    expect(found.sort()).toEqual([]);
  });
});
