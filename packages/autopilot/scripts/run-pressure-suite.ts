import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { discoverCases } from '../src/pressure-test/suite.js';
import { pressureTest, type PressureResult } from '../src/pressure-test/harness.js';

/** Run every pressure case (each in its own tmp cwd) and print a report. */
async function main(): Promise<void> {
  const cases = discoverCases();
  const results: PressureResult[] = [];
  for (const c of cases) {
    const cwd = mkdtempSync(join(tmpdir(), 'autopilot-pressure-'));
    const r = await pressureTest(c, cwd);
    results.push(r);
    console.log(`${r.verdict.padEnd(18)} ${r.skill}  ${r.scenarioName}`);
  }
  const blocked = results.filter((r) => r.verdict !== 'completed');
  console.log(`\n${results.length - blocked.length}/${results.length} completed headless.`);
  if (blocked.length > 0) {
    console.log('Not completed headless:');
    for (const r of blocked) console.log(`  ${r.verdict}  ${r.skill}  ${r.scenarioName}`);
    process.exitCode = 1;
  }
}

void main();
