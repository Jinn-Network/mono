import { parseArgs } from 'node:util';
import { join } from 'node:path';
import type { CommandContext, CommandModule } from '../command.js';
import { COMMON_FLAGS } from '../command.js';
import { emitResult } from '../output.js';
import { emitEnvelope } from '../../errors/envelope.js';
import { loadConfig, getConfigPathFromArgs, buildConfigProvenance } from '../../config.js';
import { FleetStateStore } from '../../earning/store.js';
import {
  generateMnemonic,
  encryptMnemonic,
  decryptMnemonic,
  deriveMasterAddress,
} from '../../earning/wallet.js';
import { resolveCliPassword } from '../password.js';

async function run(ctx: CommandContext): Promise<void> {
  let parsed;
  try {
    parsed = parseArgs({
      args: ctx.argv,
      options: { ...COMMON_FLAGS },
      allowPositionals: false,
    });
  } catch (err) {
    emitEnvelope(
      {
        code: 'invalid_invocation',
        message: err instanceof Error ? err.message : String(err),
        exampleCli: 'JINN_PASSWORD=... jinn init',
        details: { field: 'flags' },
      },
      { writer: ctx.writer, exit: ctx.exit },
    );
    return;
  }

  const password = resolveCliPassword(ctx.argv, ctx.env);
  if (!password.ok) {
    emitEnvelope(
      {
        code: 'invalid_invocation',
        message: password.message,
        exampleCli: 'JINN_PASSWORD=... jinn init',
        details: { field: 'keystore password', expected: 'non-empty string via environment or fd' },
      },
      { writer: ctx.writer, exit: ctx.exit },
    );
    return;
  }

  const configPath =
    getConfigPathFromArgs(ctx.argv) ?? getConfigPathFromArgs(process.argv.slice(2));
  let configEarningDir: string | undefined;
  let configNetwork: 'mainnet' | 'testnet' | undefined;
  let provenance: ReturnType<typeof buildConfigProvenance> | undefined;
  try {
    const cfg = loadConfig(configPath);
    configEarningDir = cfg.earningDir;
    configNetwork = cfg.network;
    provenance = buildConfigProvenance(configPath, cfg, ctx.env);
  } catch {
    // Config file is optional; fall back to env var / default below.
  }
  const earningDir =
    ctx.env['JINN_EARNING_DIR'] ??
    configEarningDir ??
    join(process.env['HOME'] ?? '.', '.jinn-client', 'earning');
  const store = new FleetStateStore(earningDir);

  if (!store.hasMnemonicKeystore() && store.hasLegacyKeystore()) {
    await store.migrateLegacyFiles();
  }

  let masterAddress: string;
  if (store.hasMnemonicKeystore()) {
    const mnemonic = await decryptMnemonic(await store.loadMnemonicKeystore(), password.password);
    masterAddress = deriveMasterAddress(mnemonic);
  } else {
    const mnemonic = generateMnemonic();
    const keystore = await encryptMnemonic(mnemonic, password.password);
    await store.saveMnemonicKeystore(keystore);
    masterAddress = deriveMasterAddress(mnemonic);
  }

  // Persist master_address so downstream verbs (fund-requirements,
  // bootstrap) hydrate from the existing wallet instead of rolling a
  // fresh HD mnemonic.
  const network = ctx.env['JINN_NETWORK'] ?? configNetwork ?? 'testnet';
  const chain: 'base' | 'base-sepolia' = network === 'mainnet' ? 'base' : 'base-sepolia';
  await store.patchFleet({ master_address: masterAddress, chain });

  emitResult(
    {
      schemaVersion: 1,
      generatedAt: new Date().toISOString(),
      master: masterAddress,
      keystoreDir: earningDir,
      nextStep: {
        cli: 'jinn fund-requirements',
        purpose: 'List addresses that need funding before bootstrap can advance.',
      },
      ...(provenance !== undefined ? { config: provenance } : {}),
    },
    (v) => {
      const value = v as { master: string; keystoreDir: string; nextStep: { cli: string } };
      return (
        `Keystore ready.\nMaster: ${value.master}\nDirectory: ${value.keystoreDir}\n` +
        `Next: ${value.nextStep.cli}\n` +
        `Backup: your JINN_PASSWORD and the mnemonic in this keystore are the only way to recover this wallet. ` +
        `Run \`jinn keys backup\` to export the mnemonic.`
      );
    },
    {
      json: Boolean(parsed.values.json),
      human: Boolean(parsed.values.human),
      writer: ctx.writer,
      stdoutIsTty: ctx.stdoutIsTty,
      noColor: Boolean(ctx.env['NO_COLOR']),
    },
  );
}

const command: CommandModule = {
  name: 'init',
  summary: 'Generate the master wallet and write the encrypted keystore',
  helpText: `Usage: JINN_PASSWORD=... jinn init [--human]

Idempotent. Generates a master wallet mnemonic, encrypts it with
JINN_PASSWORD, and writes the keystore. On a second run, reads the
existing keystore and returns the same master address.

Does not contact the RPC or create services. Run \`jinn bootstrap\`
after \`jinn init\` to advance the state machine.

Examples:
  JINN_PASSWORD=secret jinn init
  JINN_PASSWORD=secret jinn init --human
`,
  run,
};

export default command;
