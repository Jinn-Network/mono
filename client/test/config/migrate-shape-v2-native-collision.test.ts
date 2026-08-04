import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { validNativeProductFileContent } from '@test/native-config-fixture.js';
import { migrateConfigShapeV2 } from '../../src/config/migrate-shape-v2.js';
import { NativeProductFileSchema } from '../../src/daemon/native-product-config.js';

/**
 * Standing proof of the collision described in issue #2378: a native-v1
 * config file cannot survive the legacy shape-v2 migration + strict native
 * parse, in either direction. This is NOT a scenario the fix (own config
 * path — see issue #2378 and client/src/daemon/native-config-path.ts) makes
 * work — the fix is to never route a native file through this migration at
 * all. This file documents *why* that's the only option: both escape routes
 * the issue's author tried are provably closed.
 *
 * If this file ever goes green, something now allows a native config to
 * pass through `migrateConfigShapeV2` unscathed — re-read #2378 before
 * treating that as progress; it likely means the strict schema was relaxed,
 * which the issue explicitly rules out.
 */
function workspace(config: Record<string, unknown>): string {
  const dir = mkdtempSync(join(tmpdir(), 'jinn-native-collision-'));
  const configPath = join(dir, 'config.json');
  writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  return configPath;
}

describe('issue #2378: native config cannot survive migrateConfigShapeV2 + strict native parse', () => {
  it('escape route 1 closed: migration mutates a fresh native file, then the strict parse rejects the added keys', () => {
    const configPath = workspace(validNativeProductFileContent());

    const report = migrateConfigShapeV2({ configPath });
    expect(report.migrated).toBe(true);

    const migrated = JSON.parse(readFileSync(configPath, 'utf-8'));
    const result = NativeProductFileSchema.safeParse(migrated);

    expect(result.success).toBe(false);
    if (!result.success) {
      const unrecognized = result.error.issues.filter((issue) => issue.code === 'unrecognized_keys');
      expect(unrecognized.length).toBeGreaterThan(0);
      const badKeys = unrecognized.flatMap((issue) =>
        'keys' in issue ? issue.keys : [],
      );
      expect(badKeys).toEqual(
        expect.arrayContaining(['configShapeVersion', 'claimPolicy', 'executionWiring', 'posting']),
      );
    }
  });

  it('escape route 2 closed: pre-setting configShapeVersion dodges the migration, but the strict parse rejects that very key', () => {
    const configPath = workspace(validNativeProductFileContent({ configShapeVersion: 2 }));

    const report = migrateConfigShapeV2({ configPath });
    expect(report.migrated).toBe(false); // migration correctly no-ops

    const onDisk = JSON.parse(readFileSync(configPath, 'utf-8'));
    const result = NativeProductFileSchema.safeParse(onDisk);

    expect(result.success).toBe(false);
    if (!result.success) {
      const unrecognized = result.error.issues.find((issue) => issue.code === 'unrecognized_keys');
      expect(unrecognized).toBeDefined();
      if (unrecognized && 'keys' in unrecognized) {
        expect(unrecognized.keys).toContain('configShapeVersion');
      }
    }
  });

  it('there is no config content that satisfies both parsers: a file already migrated once can never gain a strict-native reparse', () => {
    // Even a config that starts life ALREADY at configShapeVersion 2 (so migration never fires)
    // still fails, because configShapeVersion itself is not part of the native shape. This is
    // the crux: native's strict {network, rpcUrl, operator} boundary and the legacy loader's
    // job of enriching the file are mutually exclusive, regardless of migration timing.
    const configPath = workspace(validNativeProductFileContent({ configShapeVersion: 2, claimPolicy: { mode: 'match-legacy-manifest-digest' }, executionWiring: [], posting: [] }));
    const onDisk = JSON.parse(readFileSync(configPath, 'utf-8'));
    const result = NativeProductFileSchema.safeParse(onDisk);
    expect(result.success).toBe(false);
  });
});
