import { JINN_PLUGIN_CONTRACT_VERSION } from '@jinn-network/plugin';
import { LAYER_PACKAGE_VERSION } from './version.js';

export interface JinnLayerWriter {
  write(value: string): boolean;
}

export interface RunJinnLayerCliOptions {
  writer?: JinnLayerWriter;
}

export async function runJinnLayerCli(
  argv: string[],
  options: RunJinnLayerCliOptions = {},
): Promise<number> {
  const writer = options.writer ?? process.stdout;
  if (argv.length === 2 && argv[0] === 'contract' && argv[1] === '--json') {
    writer.write(`${JSON.stringify({
      contractVersion: JINN_PLUGIN_CONTRACT_VERSION,
      packageVersion: LAYER_PACKAGE_VERSION,
    })}\n`);
    return 0;
  }
  writer.write('error: unsupported jinn-layer command\n');
  return 2;
}
