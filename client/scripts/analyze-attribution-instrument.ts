#!/usr/bin/env node

/**
 * Read-only CLI for the Stage 2 attribution instrument (#1843).
 *
 * It reads only the two paths explicitly provided by the operator and writes
 * only to stdout. Preserving the readout as an artifact is an explicit
 * operator action (for example, shell redirection to a new reviewed path).
 */

import { readFileSync } from 'node:fs';

import {
  analyzeAttributionInstrument,
  renderAttributionReadoutMarkdown,
} from '../src/eval/attribution-instrument.js';

interface CliArgs {
  preregPath: string;
  factsPath: string;
  format: 'json' | 'markdown';
}

function parseArgs(argv: string[]): CliArgs {
  let preregPath: string | undefined;
  let factsPath: string | undefined;
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
  return { preregPath, factsPath, format };
}

function readJson(label: string, path: string): unknown {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (error) {
    throw new Error(
      `unable to read ${label} at ${path}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  try {
    return JSON.parse(text) as unknown;
  } catch (error) {
    throw new Error(
      `${label} contains invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const preregistration = readJson('preregistration', args.preregPath);
  const facts = readJson('facts', args.factsPath);
  const readout = analyzeAttributionInstrument(preregistration, facts);
  const output = args.format === 'json'
    ? JSON.stringify(readout, null, 2)
    : renderAttributionReadoutMarkdown(readout);
  process.stdout.write(`${output}\n`);
}

try {
  main();
} catch (error) {
  process.stderr.write(
    `[attribution-instrument] ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
}
