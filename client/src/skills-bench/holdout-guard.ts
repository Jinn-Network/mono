import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname } from 'node:path';

interface HoldoutLedger { version: 'holdout-ledger.v1'; runs: { candidateId: string; runDir: string; at: string }[] }

async function loadLedger(file: string): Promise<HoldoutLedger> {
  if (!existsSync(file)) return { version: 'holdout-ledger.v1', runs: [] };
  return JSON.parse(await readFile(file, 'utf8')) as HoldoutLedger;
}

/** The holdout is opened once per candidate (spec §2, §4 step 5). A second run
 *  against the sealed half would make the published number an optimization
 *  target — the exact thing the split exists to prevent. */
export async function assertHoldoutUnused(ledgerFile: string, candidateId: string): Promise<void> {
  const ledger = await loadLedger(ledgerFile);
  const prior = ledger.runs.find((r) => r.candidateId === candidateId);
  if (prior) {
    throw new Error(
      `holdout already consumed for candidate '${candidateId}' (run ${prior.runDir} at ${prior.at}); ` +
      `a repeat would turn the sealed half into a tuning set`,
    );
  }
}

export async function recordHoldoutRun(
  ledgerFile: string,
  entry: { candidateId: string; runDir: string; at: string },
): Promise<void> {
  const ledger = await loadLedger(ledgerFile);
  ledger.runs.push(entry);
  await mkdir(dirname(ledgerFile), { recursive: true });
  await writeFile(ledgerFile, `${JSON.stringify(ledger, null, 2)}\n`);
}
