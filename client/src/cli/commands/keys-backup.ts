import { parseArgs } from 'node:util';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { CommandContext, CommandModule } from '../command.js';
import { emitResult } from '../output.js';
import { emitEnvelope } from '../../errors/envelope.js';
import { FleetStateStore } from '../../earning/store.js';
import { decryptMnemonic } from '../../earning/wallet.js';

async function runBackup(ctx: CommandContext, rest: string[]): Promise<void> {
  let parsed;
  try {
    parsed = parseArgs({
      args: rest,
      options: {
        output: { type: 'string' },
        json: { type: 'boolean', default: false },
        human: { type: 'boolean', default: false },
      },
      allowPositionals: false,
    });
  } catch (err) {
    emitEnvelope(
      {
        code: 'invalid_invocation',
        message: err instanceof Error ? err.message : String(err),
        exampleCli: 'jinn keys backup --output /tmp/mnemonic.txt',
        details: { field: 'flags' },
      },
      { writer: ctx.writer, exit: ctx.exit },
    );
    return;
  }

  const output = parsed.values.output as string | undefined;
  if (!output) {
    emitEnvelope(
      {
        code: 'invalid_invocation',
        message: '--output is required',
        exampleCli: 'jinn keys backup --output /tmp/mnemonic.txt',
        details: { field: '--output', expected: 'writable filesystem path' },
      },
      { writer: ctx.writer, exit: ctx.exit },
    );
    return;
  }
  const password = ctx.env['JINN_PASSWORD'];
  if (!password) {
    emitEnvelope(
      {
        code: 'invalid_invocation',
        message: 'JINN_PASSWORD is required to decrypt the keystore.',
        exampleCli: 'JINN_PASSWORD=... jinn keys backup --output /tmp/mnemonic.txt',
        details: { field: 'JINN_PASSWORD', expected: 'non-empty string' },
      },
      { writer: ctx.writer, exit: ctx.exit },
    );
    return;
  }

  const earningDir =
    ctx.env['JINN_EARNING_DIR'] ?? join(process.env['HOME'] ?? '.', '.jinn-client', 'earning');
  const store = new FleetStateStore(earningDir);
  const keystore = await store.loadMnemonicKeystore();
  const mnemonic = await decryptMnemonic(keystore, password);
  writeFileSync(output, `${mnemonic}\n`, { encoding: 'utf-8', mode: 0o600 });

  emitResult(
    {
      schemaVersion: 1,
      generatedAt: new Date().toISOString(),
      verb: 'keys backup',
      output,
      words: mnemonic.split(/\s+/).length,
    },
    (v) => {
      const value = v as { output: string; words: number };
      return `Mnemonic backup written.\nPath: ${value.output}\nWords: ${value.words}`;
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

async function run(ctx: CommandContext): Promise<void> {
  const [subverb, ...rest] = ctx.argv;
  if (!subverb) {
    emitEnvelope(
      {
        code: 'invalid_invocation',
        message: 'jinn keys requires a subverb: backup',
        exampleCli: 'jinn keys backup --output /tmp/mnemonic.txt',
        details: { field: 'subverb', expected: 'backup' },
      },
      { writer: ctx.writer, exit: ctx.exit },
    );
    return;
  }
  if (subverb === 'backup') return runBackup(ctx, rest);
  emitEnvelope(
    {
      code: 'invalid_invocation',
      message: `Unknown keys subverb: ${subverb}`,
      exampleCli: 'jinn keys backup --output /tmp/mnemonic.txt',
      details: { field: 'subverb', expected: 'backup' },
    },
    { writer: ctx.writer, exit: ctx.exit },
  );
}

const command: CommandModule = {
  name: 'keys',
  summary: 'Keystore management: backup',
  helpText: `Usage: jinn keys backup --output <path> [--human]

Decrypts the local keystore using JINN_PASSWORD and writes the
mnemonic to <path> with mode 0600. Idempotent: same mnemonic →
same output. No other side effects.

Examples:
  JINN_PASSWORD=secret jinn keys backup --output ~/backup/jinn.txt
`,
  run,
};

export default command;
