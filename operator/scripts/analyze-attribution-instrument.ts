#!/usr/bin/env node

/**
 * Read-only CLI for the Stage 2 attribution analyzer (#1899).
 *
 * It reads the preregistration, facts, and evidence manifest paths explicitly
 * provided by the operator, plus only the manifest-listed evidence files. It
 * writes only to stdout. Preserving the readout as an artifact is an explicit
 * operator action, such as shell redirection to a new reviewed path.
 */

import {
  analyzeAttributionInstrument,
  renderAttributionReadoutMarkdown,
} from '../src/eval/attribution-instrument.js';
import {
  MAX_FACTS_BYTES,
  MAX_PREREGISTRATION_BYTES,
  readAttributionEvidenceBundle,
  readBoundedRegularFile,
} from './attribution-files.js';

interface CliArgs {
  preregPath: string;
  factsPath: string;
  evidenceManifestPath: string;
  format: 'json' | 'markdown';
}

function parseArgs(argv: string[]): CliArgs {
  let preregPath: string | undefined;
  let factsPath: string | undefined;
  let evidenceManifestPath: string | undefined;
  let format: CliArgs['format'] = 'markdown';

  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    const value = argv[index + 1];
    switch (arg) {
      case '--prereg':
        if (!value || value.startsWith('--')) throw new Error('--prereg requires a file path');
        preregPath = value;
        index++;
        break;
      case '--facts':
        if (!value || value.startsWith('--')) throw new Error('--facts requires a file path');
        factsPath = value;
        index++;
        break;
      case '--evidence-manifest':
        if (!value || value.startsWith('--')) {
          throw new Error('--evidence-manifest requires a file path');
        }
        evidenceManifestPath = value;
        index++;
        break;
      case '--format':
        if (value !== 'json' && value !== 'markdown') {
          throw new Error('--format must be json or markdown');
        }
        format = value;
        index++;
        break;
      default:
        throw new Error(`unknown argument: ${arg ?? ''}`);
    }
  }

  if (!preregPath) throw new Error('--prereg is required');
  if (!factsPath) throw new Error('--facts is required');
  if (!evidenceManifestPath) throw new Error('--evidence-manifest is required');
  return { preregPath, factsPath, evidenceManifestPath, format };
}

function readJson(
  label: string,
  path: string,
  maximumBytes: number,
): { value: unknown; bytes: Buffer } {
  let bytes: Buffer;
  try {
    bytes = readBoundedRegularFile(path, maximumBytes, label);
  } catch (error) {
    throw new Error(
      `unable to read ${label} at ${path}: `
      + `${error instanceof Error ? error.message : String(error)}`,
    );
  }
  try {
    return { value: JSON.parse(bytes.toString('utf8')) as unknown, bytes };
  } catch (error) {
    throw new Error(
      `${label} contains invalid JSON: `
      + `${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const preregistration = readJson(
    'preregistration',
    args.preregPath,
    MAX_PREREGISTRATION_BYTES,
  );
  const facts = readJson('facts', args.factsPath, MAX_FACTS_BYTES);
  const evidence = readAttributionEvidenceBundle(args.evidenceManifestPath);
  const readout = await analyzeAttributionInstrument(preregistration.value, facts.value, {
    evidence,
    sourceBytes: {
      preregistration: preregistration.bytes,
      facts: facts.bytes,
    },
  });
  const output = args.format === 'json'
    ? JSON.stringify(readout, null, 2)
    : renderAttributionReadoutMarkdown(readout);
  process.stdout.write(`${output}\n`);
}

void main().catch((error: unknown) => {
  process.stderr.write(
    `[attribution-instrument] ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
});
