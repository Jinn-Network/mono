/**
 * End-to-end proof that the committed restart-drill harness runs (#2434).
 *
 * Excluded from the default unit run by `vitest.config.ts` (`test/**\/*.e2e.test.ts`) because it
 * spawns Anvil and eighteen real role-host processes. Run it with
 * `yarn drill:native-restart:verify`, or run the harness itself with `yarn drill:native-restart`.
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { PHASE_B_RESTART_CHECKPOINT_SET } from '../../src/daemon/phase-b-closure-manifest.js';
import { parseDrillReport } from '../../src/native-drill/report.js';

const OPERATOR_DIR = dirname(dirname(dirname(fileURLToPath(import.meta.url))));

async function runHarness(out: string): Promise<{ code: number | null; output: string }> {
  return new Promise((resolveWith) => {
    // Deliberately the documented invocation, so this test fails if the runbook's command breaks.
    const child = spawn('yarn', ['drill:native-restart', '--out', out], {
      cwd: OPERATOR_DIR,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', (chunk: Buffer) => { output += chunk.toString('utf8'); });
    child.stderr.on('data', (chunk: Buffer) => { output += chunk.toString('utf8'); });
    child.on('exit', (code) => resolveWith({ code, output }));
  });
}

describe('Phase B restart-drill harness', () => {
  it('emits the six named, sanitized, distinctly digested recovery reports', async () => {
    const out = mkdtempSync(join(tmpdir(), 'jinn-drill-e2e-'));
    const { code, output } = await runHarness(out);
    expect(code, output).toBe(0);

    const files = readdirSync(out).filter((name) => name !== 'recovery-reports.json');
    expect(files.sort()).toEqual(
      [...PHASE_B_RESTART_CHECKPOINT_SET].map((checkpoint) => `${checkpoint}.json`).sort(),
    );

    const digests = new Set<string>();
    for (const file of files) {
      const sealed = parseDrillReport(readFileSync(join(out, file)));
      expect(sealed.report.comparison.equalToUninterrupted).toBe(true);
      expect(sealed.report.injectedBoundary.injection).toBe('SIGKILL');
      expect(sealed.report.chain.chainId).toBe(84532);
      digests.add(sealed.digest);
    }
    expect(digests.size).toBe(files.length);

    // The manifest-ready index the harness writes alongside the reports.
    const index = JSON.parse(readFileSync(join(out, 'recovery-reports.json'), 'utf8')) as {
      recoveryReports: Array<{ checkpoint: string; digest: string }>;
    };
    expect(index.recoveryReports.map(({ checkpoint }) => checkpoint).sort())
      .toEqual([...PHASE_B_RESTART_CHECKPOINT_SET].sort());
    expect(new Set(index.recoveryReports.map(({ digest }) => digest))).toEqual(digests);
  }, 900_000);

  it('is deterministic: a second run reproduces every report apart from its timestamp', async () => {
    const first = mkdtempSync(join(tmpdir(), 'jinn-drill-det-a-'));
    const second = mkdtempSync(join(tmpdir(), 'jinn-drill-det-b-'));
    expect((await runHarness(first)).code).toBe(0);
    expect((await runHarness(second)).code).toBe(0);
    for (const checkpoint of PHASE_B_RESTART_CHECKPOINT_SET) {
      const read = (out: string): unknown => {
        const { createdAt: _stamp, ...rest } = parseDrillReport(
          readFileSync(join(out, `${checkpoint}.json`)),
        ).report;
        return rest;
      };
      // `createdAt` is provenance and is expected to move; everything a manifest reasons about --
      // the graphs, the operation ids, the transaction hashes, the effect counters -- must not.
      expect(read(second), checkpoint).toEqual(read(first));
    }
  }, 1_800_000);
});
