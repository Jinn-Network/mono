#!/usr/bin/env node

/**
 * Deterministic receipt-to-facts exporter for the Stage 2 attribution
 * instrument. It reads only explicit inputs and manifest-listed files, writes
 * the fully validated facts document to stdout, and never mutates run data.
 */

import {
  buildAttributionFacts,
} from '../src/eval/attribution-instrument.js';
import {
  MAX_PREREGISTRATION_BYTES,
  readAttributionEvidenceBundle,
  readBoundedRegularFile,
} from './attribution-files.js';

interface CliArgs {
  preregPath: string;
  evidenceManifestPath: string;
  completedAt: string;
}

function parseArgs(argv: string[]): CliArgs {
  let preregPath: string | undefined;
  let evidenceManifestPath: string | undefined;
  let completedAt: string | undefined;
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) throw new Error(`${arg ?? 'argument'} requires a value`);
    switch (arg) {
      case '--prereg':
        preregPath = value;
        break;
      case '--evidence-manifest':
        evidenceManifestPath = value;
        break;
      case '--completed-at':
        completedAt = value;
        break;
      default:
        throw new Error(`unknown argument: ${arg ?? ''}`);
    }
    index++;
  }
  if (!preregPath) throw new Error('--prereg is required');
  if (!evidenceManifestPath) throw new Error('--evidence-manifest is required');
  if (!completedAt) throw new Error('--completed-at is required');
  return { preregPath, evidenceManifestPath, completedAt };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const registration = JSON.parse(readBoundedRegularFile(
    args.preregPath,
    MAX_PREREGISTRATION_BYTES,
    'preregistration',
  ).toString('utf8')) as unknown;
  const facts = await buildAttributionFacts(
    registration,
    args.completedAt,
    readAttributionEvidenceBundle(args.evidenceManifestPath),
  );
  process.stdout.write(`${JSON.stringify(facts, null, 2)}\n`);
}

void main().catch((error: unknown) => {
  process.stderr.write(
    `[attribution-facts] ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
});
