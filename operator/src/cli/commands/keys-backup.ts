import { parseArgs } from 'node:util';
import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { CommandContext, CommandModule } from '../command.js';
import { COMMON_FLAGS } from '../command.js';
import { emitResult } from '../output.js';
import { emitEnvelope } from '../../errors/envelope.js';
import { FleetStateStore } from '../../earning/store.js';
import { decryptMnemonic, encryptMnemonic } from '../../earning/wallet.js';
import { resolveCliPassword, resolveNewPassword } from '../password.js';
import { resolveDefaultStateDir } from '../../state-dir.js';

async function runBackup(ctx: CommandContext, rest: string[]): Promise<void> {
  let parsed;
  try {
    parsed = parseArgs({
      args: rest,
      options: {
        output: { type: 'string' },
        json: { type: 'boolean', default: false },
        human: { type: 'boolean', default: false },
        config: { type: 'string' },
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
  const resolved = resolveCliPassword(rest, ctx.env);
  if (!resolved.ok) {
    emitEnvelope(
      {
        code: 'invalid_invocation',
        message: resolved.message,
        exampleCli: 'JINN_PASSWORD=... jinn keys backup --output /tmp/mnemonic.txt',
        details: { field: 'keystore password', expected: 'non-empty string via env, fd, or auto-generated file' },
      },
      { writer: ctx.writer, exit: ctx.exit },
    );
    return;
  }

  const earningDir =
    ctx.env['JINN_EARNING_DIR'] ?? join(resolveDefaultStateDir(), 'earning');
  const store = new FleetStateStore(earningDir);
  const keystore = await store.loadMnemonicKeystore();
  const mnemonic = await decryptMnemonic(keystore, resolved.password);
  writeFileSync(output, `${mnemonic}\n`, { encoding: 'utf-8', mode: 0o600 });
  process.stderr.write(
    `[warn] Mnemonic written in plaintext to ${output} (mode 0600). Treat this file as seed material.\n`,
  );

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

async function runChangePassword(ctx: CommandContext, rest: string[]): Promise<void> {
  let parsed;
  try {
    parsed = parseArgs({
      args: rest,
      options: { ...COMMON_FLAGS },
      allowPositionals: false,
    });
  } catch (err) {
    emitEnvelope(
      {
        code: 'invalid_invocation',
        message: err instanceof Error ? err.message : String(err),
        exampleCli: 'JINN_PASSWORD=old JINN_NEW_PASSWORD=new jinn keys change-password',
        details: { field: 'flags' },
      },
      { writer: ctx.writer, exit: ctx.exit },
    );
    return;
  }

  // 1. Resolve earning dir
  const earningDir =
    ctx.env['JINN_EARNING_DIR'] ?? join(resolveDefaultStateDir(), 'earning');
  const store = new FleetStateStore(earningDir);

  // 2. Check keystore exists
  if (!store.hasMnemonicKeystore()) {
    emitEnvelope(
      {
        code: 'invalid_invocation',
        message: 'No keystore found. Run `jinn init` first.',
        exampleCli: 'jinn init',
        details: { field: 'keystore' },
      },
      { writer: ctx.writer, exit: ctx.exit },
    );
    return;
  }

  // 3. Resolve current password
  const current = resolveCliPassword(ctx.argv, ctx.env);
  if (!current.ok) {
    emitEnvelope(
      {
        code: 'invalid_invocation',
        message: current.message,
        exampleCli: 'JINN_PASSWORD=old JINN_NEW_PASSWORD=new jinn keys change-password',
        details: { field: 'JINN_PASSWORD' },
      },
      { writer: ctx.writer, exit: ctx.exit },
    );
    return;
  }

  // 4. Decrypt mnemonic
  let mnemonic: string;
  try {
    mnemonic = await decryptMnemonic(await store.loadMnemonicKeystore(), current.password);
  } catch {
    emitEnvelope(
      {
        code: 'invalid_invocation',
        message: 'Failed to decrypt keystore. Wrong password?',
        exampleCli: 'JINN_PASSWORD=correct JINN_NEW_PASSWORD=new jinn keys change-password',
        details: { field: 'JINN_PASSWORD' },
      },
      { writer: ctx.writer, exit: ctx.exit },
    );
    return;
  }

  // 5. Resolve new password
  const newPass = resolveNewPassword(ctx.env);
  if (!newPass.ok) {
    emitEnvelope(
      {
        code: 'invalid_invocation',
        message: newPass.message,
        exampleCli: 'JINN_PASSWORD=old JINN_NEW_PASSWORD=new jinn keys change-password',
        details: { field: 'JINN_NEW_PASSWORD' },
      },
      { writer: ctx.writer, exit: ctx.exit },
    );
    return;
  }

  // 6. Re-encrypt
  const newKeystore = await encryptMnemonic(mnemonic, newPass.password);

  // 7. Check if daemon is running (read pidfile, process.kill(pid, 0))
  const pidPath = join(earningDir, 'daemon.pid');
  if (existsSync(pidPath)) {
    try {
      const pid = parseInt(readFileSync(pidPath, 'utf-8').trim(), 10);
      process.kill(pid, 0); // Just checks if process exists
      console.error(
        `[warn] Daemon (pid ${pid}) is running. The new password takes effect on next restart.`,
      );
    } catch {
      /* daemon not running, ignore */
    }
  }

  // 8. Save new keystore
  await store.saveMnemonicKeystore(newKeystore);

  // 9. Delete password file if it exists
  const home = ctx.env['HOME'] ?? homedir();
  const passwordFilePath = join(resolveDefaultStateDir({ home, env: ctx.env }), 'keystore-password');
  let passwordFileDeleted = false;
  if (existsSync(passwordFilePath)) {
    unlinkSync(passwordFilePath);
    passwordFileDeleted = true;
  }

  // 10. Emit result
  emitResult(
    {
      schemaVersion: 1,
      generatedAt: new Date().toISOString(),
      verb: 'keys change-password',
      keystoreDir: earningDir,
      passwordFileDeleted,
    },
    (v) => {
      const val = v as { keystoreDir: string; passwordFileDeleted: boolean };
      return (
        `Password changed.\nKeystore: ${val.keystoreDir}` +
        (val.passwordFileDeleted ? '\nAuto-generated password file deleted.' : '') +
        '\nSet JINN_PASSWORD for future commands.'
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

async function run(ctx: CommandContext): Promise<void> {
  const [subverb, ...rest] = ctx.argv;
  if (!subverb) {
    emitEnvelope(
      {
        code: 'invalid_invocation',
        message: 'jinn keys requires a subverb: backup, change-password',
        exampleCli: 'jinn keys backup --output /tmp/mnemonic.txt',
        details: { field: 'subverb', expected: 'backup | change-password' },
      },
      { writer: ctx.writer, exit: ctx.exit },
    );
    return;
  }
  if (subverb === 'backup') return runBackup(ctx, rest);
  if (subverb === 'change-password') return runChangePassword(ctx, rest);
  emitEnvelope(
    {
      code: 'invalid_invocation',
      message: `Unknown keys subverb: ${subverb}`,
      exampleCli: 'jinn keys backup --output /tmp/mnemonic.txt',
      details: { field: 'subverb', expected: 'backup | change-password' },
    },
    { writer: ctx.writer, exit: ctx.exit },
  );
}

const command: CommandModule = {
  name: 'keys',
  summary: 'Keystore management: backup, change-password',
  helpText: `Usage:
  jinn keys backup --output <path> [--human]
  jinn keys change-password [--human]

Subverbs:
  backup           Decrypt the keystore and write the mnemonic to a file.
  change-password  Re-encrypt the keystore with a new password.

backup:
  Decrypts the local keystore using JINN_PASSWORD and writes the
  mnemonic to <path> with mode 0600. Idempotent: same mnemonic →
  same output. No other side effects.

change-password:
  Decrypts the keystore with the current password (resolved from
  --password-fd, JINN_PASSWORD, or the auto-generated
  ~/.jinn-client/keystore-password file, in that order) and
  re-encrypts it with JINN_NEW_PASSWORD (min 8 characters).
  Deletes the auto-generated password file if present; after that,
  set JINN_PASSWORD yourself for subsequent commands.

Examples:
  JINN_PASSWORD=secret jinn keys backup --output ~/backup/jinn.txt
  JINN_PASSWORD=old JINN_NEW_PASSWORD=mynewpass jinn keys change-password
`,
  run,
};

export default command;
