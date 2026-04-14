import { join } from 'node:path';
import type { CommandContext, CommandModule } from '../command.js';
import { emitEnvelope } from '../../errors/envelope.js';
import { FleetStateStore } from '../../earning/store.js';
import {
  generateMnemonic,
  encryptMnemonic,
  decryptMnemonic,
  deriveMasterAddress,
} from '../../earning/wallet.js';

async function run(ctx: CommandContext): Promise<void> {
  const password = ctx.env['JINN_PASSWORD'];
  if (!password) {
    emitEnvelope(
      {
        code: 'invalid_invocation',
        message: 'JINN_PASSWORD is required to encrypt the keystore.',
        exampleCli: 'JINN_PASSWORD=... jinn init',
        details: { field: 'JINN_PASSWORD', expected: 'non-empty string' },
      },
      { writer: ctx.writer, exit: ctx.exit },
    );
    return;
  }

  const earningDir = ctx.env['JINN_EARNING_DIR'] ?? join(process.env['HOME'] ?? '.', '.jinn-client', 'earning');
  const store = new FleetStateStore(earningDir);

  if (!store.hasMnemonicKeystore() && store.hasLegacyKeystore()) {
    await store.migrateLegacyFiles();
  }

  let masterAddress: string;
  if (store.hasMnemonicKeystore()) {
    const mnemonic = await decryptMnemonic(await store.loadMnemonicKeystore(), password);
    masterAddress = deriveMasterAddress(mnemonic);
  } else {
    const mnemonic = generateMnemonic();
    const keystore = await encryptMnemonic(mnemonic, password);
    await store.saveMnemonicKeystore(keystore);
    masterAddress = deriveMasterAddress(mnemonic);
  }

  ctx.writer.write(
    JSON.stringify({
      schemaVersion: 1,
      generatedAt: new Date().toISOString(),
      master: masterAddress,
      keystoreDir: earningDir,
    }) + '\n',
  );
}

const command: CommandModule = {
  name: 'init',
  summary: 'Generate the master wallet and write the encrypted keystore',
  helpText: `Usage: JINN_PASSWORD=... jinn init [--json]

Idempotent. Generates a master wallet mnemonic, encrypts it with
JINN_PASSWORD, and writes the keystore. On a second run, reads the
existing keystore and returns the same master address.

Does not contact the RPC or create services. Run \`jinn bootstrap\`
after \`jinn init\` to advance the state machine.

Examples:
  JINN_PASSWORD=secret jinn init
  JINN_PASSWORD=secret jinn init --json | jq -r '.master'
`,
  run,
};

export default command;
