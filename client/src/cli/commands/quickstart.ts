import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import type { CommandContext, CommandModule } from '../command.js';
import { COMMON_FLAGS } from '../command.js';
import { emitEnvelope } from '../../errors/envelope.js';
import { loadConfig } from '../../config.js';
import initCommand from './init.js';
import bootstrapCommand from './bootstrap.js';
import doctorCommand from './doctor.js';

// StringWriter to capture sub-command output
class StringWriter {
  private chunks: string[] = [];
  write(s: string): boolean { this.chunks.push(s); return true; }
  toString(): string { return this.chunks.join(''); }
}

async function run(ctx: CommandContext): Promise<void> {
  let parsed;
  try {
    parsed = parseArgs({
      args: ctx.argv,
      options: {
        ...COMMON_FLAGS,
        'no-daemon': { type: 'boolean', default: false },
      },
      allowPositionals: false,
    });
  } catch (err) {
    emitEnvelope({
      code: 'invalid_invocation',
      message: err instanceof Error ? err.message : String(err),
      exampleCli: 'jinn quickstart',
      details: { field: 'flags' },
    }, { writer: ctx.writer, exit: ctx.exit });
    return;
  }

  const noDaemon = parsed.values['no-daemon'] as boolean;
  const configPath =
    typeof parsed.values.config === 'string' && parsed.values.config.length > 0
      ? parsed.values.config
      : undefined;
  const jinnDir = join(ctx.env['HOME'] ?? homedir(), '.jinn-client');
  const passwordFilePath = join(jinnDir, 'keystore-password');
  const bootstrapArgv = ['--json', ...(configPath ? ['--config', configPath] : [])];

  // ── Step 1: Resolve or generate password ──
  let password: string;
  let passwordGenerated = false;

  if (ctx.env['JINN_PASSWORD']) {
    password = ctx.env['JINN_PASSWORD'];
    console.error('[quickstart] Using password from JINN_PASSWORD environment variable.');
  } else if (existsSync(passwordFilePath)) {
    password = readFileSync(passwordFilePath, 'utf-8').trim();
    console.error('[quickstart] Using existing auto-generated password.');
  } else {
    password = randomBytes(32).toString('hex');
    mkdirSync(jinnDir, { recursive: true, mode: 0o700 });
    writeFileSync(passwordFilePath, password + '\n', { mode: 0o600 });
    passwordGenerated = true;
    console.error('[quickstart] Generated keystore password.');
  }

  const subEnv = { ...ctx.env, JINN_PASSWORD: password };

  // ── Step 1.5: Doctor preflight ──
  // Run doctor before touching any wallet state so blocking problems (missing
  // Claude binary, unreachable RPC, broken deployment) surface as the first
  // error the operator sees — not an opaque bootstrap failure eight steps in.
  console.error('[quickstart] Running preflight checks...');
  const doctorWriter = new StringWriter();
  await doctorCommand.run({
    argv: ['--json', ...(configPath ? ['--config', configPath] : [])],
    stdoutIsTty: false,
    writer: doctorWriter,
    exit: () => {},
    env: subEnv,
  });
  let doctorPayload: { ok: boolean; blockingCount: number; checks: Array<{ name: string; ok: boolean; detail: string; remedy?: string }> } | null = null;
  try {
    doctorPayload = JSON.parse(doctorWriter.toString().trim());
  } catch { /* doctor output malformed — proceed and let bootstrap fail loudly */ }
  if (doctorPayload && !doctorPayload.ok) {
    const blocking = doctorPayload.checks.filter((c) => !c.ok);
    // portfolio.v0 impl-state checks are advisory for a fresh operator who
    // hasn't submitted an HL intent yet — don't block quickstart on them.
    const realBlockers = blocking.filter(
      (c) => !c.name.startsWith('portfolio_') && !c.name.startsWith('hl_'),
    );
    if (realBlockers.length > 0) {
      console.error('[quickstart] Preflight failed. Fix the following and re-run:');
      for (const c of realBlockers) {
        console.error(`  - ${c.name}: ${c.detail}`);
        if (c.remedy) console.error(`      remedy: ${c.remedy}`);
      }
      ctx.exit(11);
      return;
    }
  }
  console.error('[quickstart] Preflight OK.');

  // ── Step 2: Init (idempotent) ──
  console.error('[quickstart] Initializing wallet...');
  const initWriter = new StringWriter();
  let initExitCode: number | null = null;
  await initCommand.run({
    argv: ['--json'],
    stdoutIsTty: false,
    writer: initWriter,
    exit: (code) => { initExitCode = code; },
    env: subEnv,
  });

  if (initExitCode !== null && initExitCode !== 0) {
    console.error('[quickstart] Init failed.');
    ctx.writer.write(initWriter.toString());
    ctx.exit(initExitCode);
    return;
  }

  // Parse master address from init output
  let masterAddress = '';
  try {
    const initResult = JSON.parse(initWriter.toString().trim());
    masterAddress = initResult.master ?? '';
  } catch { /* non-fatal */ }
  console.error(`[quickstart] Wallet ready. Master: ${masterAddress || '(see init output)'}`);

  // ── Step 3: Bootstrap (with retry for funding gates) ──
  const MAX_BOOTSTRAP_ATTEMPTS = 3;
  let bootstrapSuccess = false;

  for (let attempt = 1; attempt <= MAX_BOOTSTRAP_ATTEMPTS; attempt++) {
    console.error(`[quickstart] Running bootstrap (attempt ${attempt}/${MAX_BOOTSTRAP_ATTEMPTS})...`);
    const bsWriter = new StringWriter();
    let bsExitCode: number | null = null;
    await bootstrapCommand.run({
      argv: bootstrapArgv,
      stdoutIsTty: false,
      writer: bsWriter,
      exit: (code) => { bsExitCode = code; },
      env: subEnv,
    });

    if (bsExitCode === null || bsExitCode === 0) {
      bootstrapSuccess = true;
      console.error('[quickstart] Bootstrap complete.');
      break;
    }

    // Exit code 10 = funding_required — the faucet integration in bootstrap.ts
    // will have already attempted auto-funding. If we're here, manual funding is needed.
    if (bsExitCode === 10) {
      const bsOutput = bsWriter.toString().trim();
      console.error('[quickstart] Funding required. Waiting for manual funding...');
      try {
        const envelope = JSON.parse(bsOutput);
        if (envelope.details?.address) {
          console.error(`  Address: ${envelope.details.address}`);
        }
        if (envelope.hint) {
          console.error(`  ${envelope.hint}`);
        }
      } catch { /* non-fatal */ }
      console.error('  Faucet: https://portal.cdp.coinbase.com/products/faucet');
      console.error('  Polling every 15s for funding...');

      // Poll until funded or timeout (30 min)
      const pollInterval = 15_000;
      const maxPolls = 120;
      let funded = false;
      for (let i = 0; i < maxPolls; i++) {
        await new Promise(r => setTimeout(r, pollInterval));
        // Re-attempt bootstrap to check if funding arrived
        const checkWriter = new StringWriter();
        let checkExit: number | null = null;
        await bootstrapCommand.run({
          argv: bootstrapArgv,
          stdoutIsTty: false,
          writer: checkWriter,
          exit: (code) => { checkExit = code; },
          env: { ...subEnv, JINN_DISABLE_TESTNET_FAUCET: '1' },
        });
        if (checkExit === null || checkExit === 0) {
          funded = true;
          bootstrapSuccess = true;
          console.error('[quickstart] Funding received. Bootstrap complete.');
          break;
        }
        if (checkExit !== 10) {
          // Different error — relay and exit
          console.error('[quickstart] Bootstrap failed with unexpected error.');
          ctx.writer.write(checkWriter.toString());
          ctx.exit(checkExit ?? 50);
          return;
        }
        if ((i + 1) % 4 === 0) {
          console.error(`  Still waiting... (${Math.round((i + 1) * pollInterval / 60000)} min elapsed)`);
        }
      }
      if (funded) break;
      console.error('[quickstart] Timeout waiting for funding (30 min). Run `jinn quickstart` again after funding.');
      ctx.exit(10);
      return;
    }

    // Other exit codes — fatal
    console.error('[quickstart] Bootstrap failed.');
    ctx.writer.write(bsWriter.toString());
    ctx.exit(bsExitCode);
    return;
  }

  if (!bootstrapSuccess) {
    console.error('[quickstart] Bootstrap did not complete after retries.');
    ctx.exit(50);
    return;
  }

  // ── Step 4: Print summary ──
  const apiPort = String(loadConfig(configPath).apiPort);
  const keystoreFile = join(jinnDir, 'earning', 'master_keystore.json');
  console.error('');
  if (passwordGenerated) {
    const bar = '━'.repeat(64);
    console.error(bar);
    console.error('Your Jinn wallet has been created.');
    console.error('');
    console.error(`  Master address:  ${masterAddress || '(run `jinn version` to read)'}`);
    console.error(`  Keystore:        ${keystoreFile}`);
    console.error(`  Password:        ${passwordFilePath}`);
    console.error(`  Dashboard:       http://127.0.0.1:${apiPort}`);
    console.error('');
    console.error('Back up your mnemonic NOW to somewhere off this machine:');
    console.error('  jinn keys backup --output /path/to/secure/location.txt');
    console.error('');
    console.error('TESTER TIER — treat this wallet as hot.');
    console.error('  The password file sits next to the encrypted keystore, so anyone');
    console.error('  with shell access to this machine can decrypt it. Keep funds to');
    console.error('  the gas + rewards minimum; use a hardware wallet for anything else.');
    console.error('');
    console.error('To rotate the password: JINN_NEW_PASSWORD=<new> jinn keys change-password');
    console.error(bar);
  } else {
    console.error('Quickstart complete!');
    console.error(`  Dashboard: http://127.0.0.1:${apiPort}`);
  }
  console.error('');

  if (noDaemon) {
    ctx.writer.write(JSON.stringify({
      schemaVersion: 1,
      generatedAt: new Date().toISOString(),
      verb: 'quickstart',
      status: 'ready',
      masterAddress,
      dashboardUrl: `http://127.0.0.1:${apiPort}`,
      passwordFile: passwordGenerated ? passwordFilePath : undefined,
    }) + '\n');
    return;
  }

  // ── Step 5: Start daemon (foreground) ──
  console.error('Starting daemon...');

  // Route console to stderr for daemon (same as run command does)
  const stderrWriter = (line: string): void => {
    process.stderr.write(line.endsWith('\n') ? line : `${line}\n`);
  };
  console.log = (...args: unknown[]) => stderrWriter(args.map(String).join(' '));
  console.info = (...args: unknown[]) => stderrWriter(args.map(String).join(' '));
  console.warn = (...args: unknown[]) => stderrWriter(args.map(String).join(' '));
  console.error = (...args: unknown[]) => stderrWriter(args.map(String).join(' '));

  // Set password in process env so main.ts can read it
  process.env['JINN_PASSWORD'] = password;

  const { main } = await import('../../main.js');
  const payload = await main();
  ctx.writer.write(JSON.stringify(payload) + '\n');
}

const command: CommandModule = {
  name: 'quickstart',
  summary: 'Zero-to-running in one command: init, fund, bootstrap, run',
  helpText: `Usage: jinn quickstart [--no-daemon] [--config <path>]

One command to go from nothing to a running Jinn daemon:
  1. Generate a keystore password (or use JINN_PASSWORD)
  2. Create the master wallet
  3. Fund via faucet (automatic on testnet if CDP SDK available)
  4. Bootstrap the fleet state machine
  5. Start the daemon

Idempotent. Re-running after partial completion resumes from
wherever it left off.

Examples:
  jinn quickstart
  jinn quickstart --no-daemon
  JINN_PASSWORD=mysecret jinn quickstart
`,
  run,
};
export default command;
