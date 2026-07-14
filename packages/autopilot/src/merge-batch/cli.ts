import { createMergeBatchManifest } from './manifest.js';
import type { MergeBatchPr } from './types.js';

export interface MergeBatchCliIo {
  argv: string[];
  write: (text: string) => void;
  writeError: (text: string) => void;
}

interface FixtureInput {
  baseNextSha: string;
  createdAt: string;
  maxWaveSize: number;
  prs: MergeBatchPr[];
}

export async function runMergeBatchCli(io: MergeBatchCliIo): Promise<number> {
  const [command, flag, value] = io.argv;
  if (command !== 'plan' || flag !== '--fixture-json' || value == null) {
    io.writeError('usage: jinn-merge-batch plan --fixture-json <json>\n');
    return 2;
  }

  const fixture = JSON.parse(value) as FixtureInput;
  const manifest = createMergeBatchManifest(fixture);
  io.write(`${JSON.stringify(manifest, null, 2)}\n`);
  return 0;
}
