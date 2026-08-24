// Run a single trial. Usage: tsx src/run-trial.ts <instanceDir> <runLabel> [trial] [model]
import { runTrial } from './lib/trial.js';

async function main() {
  const [instanceDir, runLabel, trialStr, model] = process.argv.slice(2);
  if (!instanceDir || !runLabel) throw new Error('usage: run-trial.ts <instanceDir> <runLabel> [trial] [model]');
  const r = await runTrial({ instanceDir, runLabel, trial: Number(trialStr ?? '1'), model });
  console.log(JSON.stringify(r, (_k, v) => (typeof v === 'bigint' ? String(v) : v), 2));
  process.exit(0);
}

main().catch((err) => { console.error(err); process.exit(1); });
