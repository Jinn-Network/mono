import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  auditCuratedSeedBatch,
  type CuratedSeedBatchAudit,
  createLocalEpisodeSeedSource,
} from '@jinn-network/jinn-layer';

const DEFAULT_REPO_SLUG = 'Jinn-Network/mono';
const MAX_CURATED_EPISODE_FILES = 100;
const MAX_CURATED_EPISODE_BYTES = 1_048_576;

export interface CuratedSeedBatchCliArgs {
  episodesDir: string;
  repoSlug: string;
  json: boolean;
}

export interface CuratedSeedBatchCliIO {
  stdout(text: string): void;
  stderr(text: string): void;
}

function takeValue(argv: readonly string[], index: number, flag: string): string {
  const value = argv[index + 1];
  if (!value || value.startsWith('--')) {
    throw new Error(`${flag} requires a value`);
  }
  return value;
}

export function parseCuratedSeedBatchArgs(
  argv: readonly string[],
): CuratedSeedBatchCliArgs {
  let episodesDir: string | undefined;
  let repoSlug = DEFAULT_REPO_SLUG;
  let json = false;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    switch (arg) {
      case '--episodes-dir':
        episodesDir = takeValue(argv, index, arg);
        index += 1;
        break;
      case '--repo':
        repoSlug = takeValue(argv, index, arg);
        index += 1;
        break;
      case '--json':
        json = true;
        break;
      default:
        throw new Error(`unknown argument: ${arg}`);
    }
  }

  if (!episodesDir) {
    throw new Error('--episodes-dir is required');
  }
  return { episodesDir, repoSlug, json };
}

function renderHumanReport(report: CuratedSeedBatchAudit): string {
  const lines = [
    `Automated audit: ${report.automatedStatus.toUpperCase()}`,
    `Repository: ${report.repoSlug}`,
    `Mechanically eligible: ${report.eligibleRecordCount}/${report.requiredRecords} required (${report.recordCount} checked)`,
    `Probe vocabulary: ${report.probeTerms.join(', ') || '(none)'}`,
  ];
  for (const error of report.errors) lines.push(`ERROR: ${error}`);
  for (const record of report.records) {
    lines.push(`${record.automatedStatus.toUpperCase()}: ${record.id}`);
    for (const error of record.errors) lines.push(`  - ${error}`);
  }
  lines.push(
    'Human curation judgment: REQUIRED',
    'Publication authorized: NO',
    `Live probe: NOT RUN (${report.liveProbe.command})`,
  );
  return `${lines.join('\n')}\n`;
}

export async function runCuratedSeedBatchValidator(
  argv: readonly string[],
  io: CuratedSeedBatchCliIO = {
    stdout: (text) => process.stdout.write(text),
    stderr: (text) => process.stderr.write(text),
  },
): Promise<number> {
  const args = parseCuratedSeedBatchArgs(argv);
  const source = createLocalEpisodeSeedSource(resolve(args.episodesDir), {
    maxFiles: MAX_CURATED_EPISODE_FILES,
    maxFileBytes: MAX_CURATED_EPISODE_BYTES,
    rejectSymlinks: true,
  });
  const report = await auditCuratedSeedBatch({
    repoSlug: args.repoSlug,
    episodes: await source.list(),
  });
  io.stdout(args.json ? `${JSON.stringify(report, null, 2)}\n` : renderHumanReport(report));
  return report.automatedStatus === 'pass' ? 0 : 1;
}

export async function main(
  argv: readonly string[] = process.argv.slice(2),
): Promise<number> {
  try {
    return await runCuratedSeedBatchValidator(argv);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`curated seed audit failed: ${message}\n`);
    return 2;
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  process.exitCode = await main();
}
