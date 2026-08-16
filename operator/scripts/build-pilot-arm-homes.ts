/** CLI wrapper for src/pilot/arm-homes.ts — build per-arm isolated jinn-agent
 *  homes and emit the arms.json (with jinnAgentHome filled in) to pass to
 *  run-pilot.ts. See the module header in src/pilot/arm-homes.ts for why.
 *
 * Usage:
 *   yarn tsx scripts/build-pilot-arm-homes.ts \
 *     --arms-file <arms.json> --dest <dir> [--source ~/.jinn-agent] [--out <arms-with-homes.json>]
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { buildArmHomes, type ArmHomeSpec } from '../src/pilot/arm-homes.js';

function main(): void {
  const argv = process.argv.slice(2);
  let armsFilePath = '';
  let sourceDir = join(homedir(), '.jinn-agent');
  let destDir = '';
  let outPath = '';
  for (let i = 0; i < argv.length; i++) {
    switch (argv[i]) {
      case '--arms-file': armsFilePath = resolve(String(argv[++i])); break;
      case '--source': sourceDir = resolve(String(argv[++i])); break;
      case '--dest': destDir = resolve(String(argv[++i])); break;
      case '--out': outPath = resolve(String(argv[++i])); break;
      default: throw new Error(`unknown flag ${argv[i]}`);
    }
  }
  if (!armsFilePath || !destDir) throw new Error('usage: --arms-file <arms.json> --dest <dir> [--source <home>] [--out <path>]');

  const armsFile = JSON.parse(readFileSync(armsFilePath, 'utf-8')) as ArmHomeSpec[];
  const arms = buildArmHomes({ armsFile, sourceDir, destDir });
  const emitted = outPath || join(destDir, 'arms.json');
  writeFileSync(emitted, `${JSON.stringify(arms, null, 2)}\n`);
  for (const arm of arms) console.log(`[arm-homes] ${arm.name}: ${arm.jinnAgentHome} (${arm.skills.length} distilled skills)`);
  console.log(`[arm-homes] arms file with homes: ${emitted}`);
}

main();
