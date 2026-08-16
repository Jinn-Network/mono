import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  KNOWN_INSTANCE_HF_FIXTURE_PATH,
  KNOWN_INSTANCE_HF_FIXTURE_SCHEMA,
  RECORD_FIXTURE_COMMAND,
  loadKnownInstanceHfFixture,
} from '../release/tier-2/fixtures/known-instance-hf-fixture.js';
import { KNOWN_INSTANCE_ID, KNOWN_REPO } from '../release/tier-2/fixtures/known-instance.js';

// Fixture-first loading for the AC1 amd64 gold proof (issue #1683): the
// committed fixture must load without any network access, and a
// missing/malformed fixture must fail loud naming the record command —
// never silently fall back to a live HF fetch.

describe('AC1 known-instance HF fixture', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ac1-fixture-test-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function writeFixture(mutate: (f: Record<string, any>) => void): string {
    const f = JSON.parse(readFileSync(KNOWN_INSTANCE_HF_FIXTURE_PATH, 'utf8'));
    mutate(f);
    const path = join(dir, 'known-instance-hf.json');
    writeFileSync(path, JSON.stringify(f));
    return path;
  }

  it('loads the committed fixture with zero network calls', () => {
    // Prove hermeticity of the default load path: any fetch attempt throws.
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (() => {
      throw new Error('fixture load path must not touch the network');
    }) as typeof fetch;
    try {
      const fixture = loadKnownInstanceHfFixture();
      expect(fixture.schemaVersion).toBe(KNOWN_INSTANCE_HF_FIXTURE_SCHEMA);
      expect(fixture.poolTask.instance_id).toBe(KNOWN_INSTANCE_ID);
      expect(fixture.poolTask.hf_dataset).toBeTruthy();
      expect(fixture.poolTask.hf_split).toBeTruthy();
      // The gold patch is what the admission run grades.
      expect(fixture.poolTask.patch).toBeTruthy();
      expect(fixture.hfRow.instance_id).toBe(KNOWN_INSTANCE_ID);
      expect(fixture.hfRow.repo).toBe(KNOWN_REPO);
      expect(fixture.hfRow.image_name).toBeTruthy();
      expect(fixture.hfRow.FAIL_TO_PASS.length).toBeGreaterThan(0);
      expect(Array.isArray(fixture.hfRow.PASS_TO_PASS)).toBe(true);
      expect(fixture.hfRow.test_patch).toBeTruthy();
      expect(typeof fixture.hfRow.install_config.log_parser).toBe('string');
      expect(fixture.hfRow.install_config.test_cmd).toBeTruthy();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('missing fixture fails loud naming the record command', () => {
    const missing = join(dir, 'does-not-exist.json');
    expect(() => loadKnownInstanceHfFixture(missing)).toThrowError(/is missing/);
    expect(() => loadKnownInstanceHfFixture(missing)).toThrowError(
      RECORD_FIXTURE_COMMAND.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'),
    );
  });

  it('unparsable JSON fails loud naming the record command', () => {
    const path = join(dir, 'known-instance-hf.json');
    writeFileSync(path, 'not json {');
    expect(() => loadKnownInstanceHfFixture(path)).toThrowError(/is not valid JSON/);
    expect(() => loadKnownInstanceHfFixture(path)).toThrowError(/--record-fixture/);
  });

  it('wrong schemaVersion fails loud', () => {
    const path = writeFixture((f) => {
      f.schemaVersion = 'something-else.v9';
    });
    expect(() => loadKnownInstanceHfFixture(path)).toThrowError(/schemaVersion/);
  });

  it('missing grading-load-bearing field (image_name) fails loud', () => {
    const path = writeFixture((f) => {
      delete f.hfRow.image_name;
    });
    expect(() => loadKnownInstanceHfFixture(path)).toThrowError(/hfRow\.image_name/);
  });

  it('missing gold patch fails loud', () => {
    const path = writeFixture((f) => {
      f.poolTask.patch = '';
    });
    expect(() => loadKnownInstanceHfFixture(path)).toThrowError(/poolTask\.patch/);
  });

  it('fixture recorded for a different instance (stale after rotation) fails loud', () => {
    const path = writeFixture((f) => {
      f.poolTask.instance_id = 'some__other-1';
      f.hfRow.instance_id = 'some__other-1';
    });
    expect(() => loadKnownInstanceHfFixture(path)).toThrowError(
      new RegExp(`current known instance is ${KNOWN_INSTANCE_ID}`),
    );
  });
});
