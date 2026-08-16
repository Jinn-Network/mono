import { randomBytes as defaultRandomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import type { BaseCommandDeps, CommandContext, CommandModule } from '../command.js';
import { COMMON_FLAGS } from '../command.js';
import { emitEnvelope } from '../../errors/envelope.js';
import {
  loadConfig as defaultLoadConfig,
  getConfigPathFromArgs as defaultGetConfigPathFromArgs,
} from '../../config.js';
import initCommand from './init.js';
import bootstrapCommand from './bootstrap.js';
import doctorCommand from './doctor.js';
import {
  checkRpcNetwork as defaultCheckRpcNetwork,
  rpcNetworkFailureHint as defaultRpcNetworkFailureHint,
} from '../../preflight/rpc-network.js';
import {
  apiPortFailureMessage as defaultApiPortFailureMessage,
  checkApiPortAvailable as defaultCheckApiPortAvailable,
} from '../../preflight/api-port.js';

// ── Structured progress envelope ─────────────────────────────────────────────

/**
 * NDJSON progress envelope emitted on stdout during long-running lifecycle
 * verbs when `--json-progress` is set (or when stdout is non-TTY in JSON
 * mode). Fields are stable — callers may depend on them.
 *
 * @field type     Always "progress".
 * @field phase    Top-level phase: "preflight" | "password" | "init" | "bootstrap" | "daemon".
 * @field step     Human-readable label for the current step within the phase.
 * @field attempt  1-based attempt counter (present during retry loops).
 * @field blocking Whether the agent must act before this step can advance.
 * @field nextAction  Short instruction for the agent/operator when blocking is true.
 * @field addresses   Any relevant on-chain addresses the agent may need.
 * @field estimatedWaitMs  Rough upper bound on how long the step may take.
 */
export interface QuickstartProgressEnvelope {
  type: 'progress';
  phase: 'preflight' | 'password' | 'init' | 'bootstrap' | 'daemon';
  step: string;
  attempt?: number;
  blocking?: boolean;
  nextAction?: string;
  addresses?: Record<string, string>;
  estimatedWaitMs?: number;
}

function emitProgress(
  writer: { write(s: string): boolean },
  envelope: QuickstartProgressEnvelope,
): void {
  writer.write(JSON.stringify(envelope) + '\n');
}

// StringWriter to capture sub-command output
class StringWriter {
  private chunks: string[] = [];
  write(s: string): boolean { this.chunks.push(s); return true; }
  toString(): string { return this.chunks.join(''); }
}

export interface PasswordFileIO {
  exists(path: string): boolean;
  read(path: string): string;
  write(path: string, content: string): void;
  remove(path: string): void;
  ensureDir(path: string): void;
}

const DEFAULT_PASSWORD_FILE_IO: PasswordFileIO = {
  exists: (path) => existsSync(path),
  read: (path) => readFileSync(path, 'utf-8'),
  write: (path, content) => writeFileSync(path, content, { mode: 0o600 }),
  remove: (path) => {
    try { unlinkSync(path); } catch { /* best effort — file may not exist */ }
  },
  ensureDir: (path) => mkdirSync(path, { recursive: true, mode: 0o700 }),
};

export interface QuickstartDeps extends BaseCommandDeps {
  checkRpcNetwork: typeof defaultCheckRpcNetwork;
  rpcNetworkFailureHint: typeof defaultRpcNetworkFailureHint;
  checkApiPortAvailable: typeof defaultCheckApiPortAvailable;
  apiPortFailureMessage: typeof defaultApiPortFailureMessage;
  /** Wraps the dynamic import('../../main.js') + invocation. Production calls main(); tests inject a no-op. */
  mainFn: () => Promise<unknown>;
  initRun: typeof initCommand.run;
  bootstrapRun: typeof bootstrapCommand.run;
  doctorRun: typeof doctorCommand.run;
  passwordFileIO: PasswordFileIO;
  randomBytesFn: (n: number) => Buffer;
}

const PRODUCTION_DEPS: QuickstartDeps = {
  loadConfig: defaultLoadConfig,
  getConfigPathFromArgs: defaultGetConfigPathFromArgs,
  checkRpcNetwork: defaultCheckRpcNetwork,
  rpcNetworkFailureHint: defaultRpcNetworkFailureHint,
  checkApiPortAvailable: defaultCheckApiPortAvailable,
  apiPortFailureMessage: defaultApiPortFailureMessage,
  // environment plumbing for the spawned daemon — out of DI scope
  mainFn: async () => {
    const m = await import('../../main.js');
    return m.main();
  },
  initRun: initCommand.run.bind(initCommand),
  bootstrapRun: bootstrapCommand.run.bind(bootstrapCommand),
  doctorRun: doctorCommand.run.bind(doctorCommand),
  passwordFileIO: DEFAULT_PASSWORD_FILE_IO,
  randomBytesFn: defaultRandomBytes,
};

export function createQuickstartCommand(deps: QuickstartDeps = PRODUCTION_DEPS): CommandModule {
  return {
    name: 'quickstart',
    summary: 'Legacy compatibility alias for zero-to-running setup; prefer jinn run',
    helpText: `Usage: jinn quickstart [--no-daemon] [--json-progress] [--config <path>]

Compatibility command. New operators should run \`jinn run\`; it opens the
operator app and walks Claude/runtime setup there when needed.

One command to go from nothing to a running Jinn daemon:
  1. Generate a keystore password (or use JINN_PASSWORD)
  2. Create the master wallet
  3. Fund via faucet (automatic on testnet if CDP SDK available)
  4. Bootstrap the fleet state machine
  5. Start the daemon (unless --no-daemon is passed)

Idempotent. Re-running after partial completion resumes from
wherever it left off.

Flags:
  --no-daemon       Stop after bootstrap; do not start the daemon.
  --json-progress   Emit NDJSON progress envelopes on stdout during each
                    phase. Envelopes have stable fields: type, phase, step,
                    attempt, blocking, nextAction, addresses, estimatedWaitMs.
                    Automatically enabled in --json mode on non-TTY stdout.
  --config <path>   Path to config file.

Runtime mode:
  New operators do not need to choose a runtime mode at the CLI. Complete any
  required Claude/runtime setup in the app opened by \`jinn run\`.

Password handling:
  If JINN_PASSWORD is set in the environment, that value is used — no file
  is written. This is the recommended approach for CI and advanced use.

  Otherwise quickstart auto-generates a random password and writes it to
  ~/.jinn-client/keystore-password (mode 0600). This file sits next to the
  encrypted keystore, so anyone with shell access to this machine can
  decrypt the wallet. Keep funds to the gas + rewards minimum.

  To rotate: JINN_NEW_PASSWORD=<new> jinn keys change-password

Agent/script mode (--json / --no-daemon / --json-progress):
  jinn quickstart --no-daemon --json
  jinn quickstart --json-progress   # polls progress without parsing stderr

  Pass --no-daemon to skip starting the foreground daemon. quickstart will
  complete all setup steps and then emit a single JSON payload on stdout:

    {
      "schemaVersion": 1,
      "generatedAt": "<ISO timestamp>",
      "verb": "quickstart",
      "status": "ready",
      "masterAddress": "0x...",
      "dashboardUrl": "http://127.0.0.1:7331",
      "passwordFile": "~/.jinn-client/keystore-password"  // omitted if JINN_PASSWORD was used
    }

  Operational verbs emit JSON on stdout by default. Use --human for
  terminal-readable output.

Examples:
  # Recommended first run
  jinn run

  # Legacy compatibility
  jinn quickstart

  # Skip the daemon — emit JSON and exit (agent/script mode)
  jinn quickstart --no-daemon
  JINN_PASSWORD=mysecret jinn quickstart
  jinn quickstart --json-progress 2>/dev/null

  # CI: supply password via env, no daemon
  JINN_PASSWORD=mysecret jinn quickstart --no-daemon

  # Custom config
  jinn quickstart --config /etc/jinn/config.json
`,
    async run(ctx: CommandContext): Promise<void> {
      let parsed;
      try {
        parsed = parseArgs({
          args: ctx.argv,
          options: {
            ...COMMON_FLAGS,
            'no-daemon': { type: 'boolean', default: false },
            'json-progress': { type: 'boolean', default: false },
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
      // Emit NDJSON progress envelopes when --json-progress is set or stdout is
      // non-TTY in JSON mode (agent / MCP callers). This lets a polling agent
      // know which step is active without parsing stderr.
      const jsonProgress = (parsed.values['json-progress'] as boolean) ||
        (!ctx.stdoutIsTty && Boolean(parsed.values.json));
      const configPath =
        typeof parsed.values.config === 'string' && parsed.values.config.length > 0
          ? parsed.values.config
          : undefined;
      const jinnDir = join(ctx.env['HOME'] ?? homedir(), '.jinn-client');
      const passwordFilePath = join(jinnDir, 'keystore-password');
      const keystoreFilePath = join(jinnDir, 'earning', 'master_keystore.json');
      const bootstrapArgv = ['--json', ...(configPath ? ['--config', configPath] : [])];

      // ── Preflight (no secret state yet) ──
      // SECURITY (audit W4, jinn-mono-964.6): all non-secret preflight runs
      // BEFORE we generate or write any plaintext password material. If any
      // blocking preflight fails we exit with no orphan secrets on disk.
      const config = deps.loadConfig(configPath);

      // Track whether we touched the password file so error paths can report
      // accurate cleanup state in the structured envelope.
      let passwordGenerated = false;
      // `passwordFilePreexisted` records whether the on-disk password file
      // existed *before* this quickstart invocation. We must never delete a
      // file the user already had — only one we just wrote.
      const passwordFilePreexisted = deps.passwordFileIO.exists(passwordFilePath);

      const cleanupGeneratedPasswordIfOrphaned = (): { removed: boolean; reason: string } => {
        // Defense in depth: only remove the password file if we generated it
        // AND no keystore exists yet. Keystore presence means a usable wallet
        // was created (the password is needed to decrypt it).
        if (!passwordGenerated) return { removed: false, reason: 'not_generated_this_run' };
        if (deps.passwordFileIO.exists(keystoreFilePath)) {
          return { removed: false, reason: 'keystore_exists' };
        }
        deps.passwordFileIO.remove(passwordFilePath);
        return { removed: true, reason: 'orphan_cleanup' };
      };

      const rpcPreflight = await deps.checkRpcNetwork(config);
      if (!rpcPreflight.ok) {
        const cleanup = cleanupGeneratedPasswordIfOrphaned();
        emitEnvelope({
          code: 'invalid_invocation',
          message: rpcPreflight.message,
          hint: deps.rpcNetworkFailureHint(rpcPreflight),
          exampleCli: 'jinn doctor --human',
          details: {
            field: 'rpcUrl',
            network: rpcPreflight.network,
            expectedChainId: rpcPreflight.expectedChainId,
            actualChainId: rpcPreflight.actualChainId ?? null,
            rpcHost: rpcPreflight.rpcHost,
            reason: rpcPreflight.reason,
            passwordGenerated,
            passwordFileCleanup: cleanup,
          },
        }, { writer: ctx.writer, exit: ctx.exit });
        return;
      }

      if (!noDaemon) {
        const portPreflight = await deps.checkApiPortAvailable(config.apiPort);
        if (!portPreflight.ok) {
          const cleanup = cleanupGeneratedPasswordIfOrphaned();
          emitEnvelope({
            code: 'invalid_invocation',
            message: deps.apiPortFailureMessage(portPreflight),
            hint: 'Stop the other daemon or set JINN_API_PORT / apiPort to a free port before running quickstart.',
            exampleCli: 'JINN_API_PORT=7332 jinn quickstart',
            details: {
              field: 'apiPort',
              port: portPreflight.port,
              reason: portPreflight.code ?? 'unavailable',
              passwordGenerated,
              passwordFileCleanup: cleanup,
            },
          }, { writer: ctx.writer, exit: ctx.exit });
          return;
        }
      }

      // ── Doctor preflight ──
      // Run doctor before touching any wallet state so blocking problems (missing
      // Claude binary, unreachable RPC, broken deployment) surface as the first
      // error the operator sees — not an opaque bootstrap failure eight steps in.
      // Doctor needs JINN_PASSWORD set to a non-empty value to skip its own
      // password preflight, but this is a transient in-process value only —
      // we still don't write any password material to disk yet.
      if (jsonProgress) {
        emitProgress(ctx.writer, { type: 'progress', phase: 'preflight', step: 'doctor_checks', estimatedWaitMs: 5000 });
      }
      console.error('[quickstart] Running preflight checks...');
      const doctorTransientPassword = ctx.env['JINN_PASSWORD']
        ?? (passwordFilePreexisted ? deps.passwordFileIO.read(passwordFilePath).trim() : 'preflight-only');
      const doctorWriter = new StringWriter();
      await deps.doctorRun({
        argv: ['--json', ...(configPath ? ['--config', configPath] : [])],
        stdoutIsTty: false,
        writer: doctorWriter,
        exit: () => {},
        env: { ...ctx.env, JINN_PASSWORD: doctorTransientPassword },
      });
      let doctorPayload: { ok: boolean; blockingCount: number; checks: Array<{ name: string; ok: boolean; detail: string; remedy?: string }> } | null = null;
      try {
        doctorPayload = JSON.parse(doctorWriter.toString().trim());
      } catch { /* doctor output malformed — proceed and let bootstrap fail loudly */ }
      if (doctorPayload && !doctorPayload.ok) {
        const blocking = doctorPayload.checks.filter((c) => !c.ok);
        // portfolio.v0 impl-state checks are advisory for a fresh operator who
        // hasn't submitted an HL task yet — don't block quickstart on them.
        const realBlockers = blocking.filter(
          (c) => !c.name.startsWith('portfolio_') && !c.name.startsWith('hl_'),
        );
        if (realBlockers.length > 0) {
          // No password file written yet; cleanup is trivially a no-op but we
          // still report status so the envelope contract is uniform.
          const cleanup = cleanupGeneratedPasswordIfOrphaned();
          console.error('[quickstart] Preflight failed. Fix the following and re-run:');
          for (const c of realBlockers) {
            console.error(`  - ${c.name}: ${c.detail}`);
            if (c.remedy) console.error(`      remedy: ${c.remedy}`);
          }
          emitEnvelope({
            code: 'invalid_invocation',
            message: 'Doctor preflight reported blocking issues.',
            hint: 'Run `jinn doctor --human` for full remedies, fix the blockers, and re-run `jinn quickstart`.',
            exampleCli: 'jinn doctor --human',
            details: {
              field: 'doctor',
              blockers: realBlockers.map((c) => ({ name: c.name, detail: c.detail, remedy: c.remedy ?? null })),
              passwordGenerated,
              passwordFileCleanup: cleanup,
            },
          }, { writer: ctx.writer, exit: ctx.exit });
          return;
        }
      }
      console.error('[quickstart] Preflight OK.');

      // ── Resolve or generate password (post-preflight) ──
      // Only now, after every non-secret preflight has passed, do we touch
      // disk for password material. This is the W4 fix from the 2026-04-28
      // operator-experience audit: never leave a plaintext password file
      // behind when no usable wallet was created.
      if (jsonProgress) {
        emitProgress(ctx.writer, { type: 'progress', phase: 'password', step: 'resolving_password', estimatedWaitMs: 100 });
      }
      let password: string;
      if (ctx.env['JINN_PASSWORD']) {
        password = ctx.env['JINN_PASSWORD'];
        console.error('[quickstart] Using password from JINN_PASSWORD environment variable.');
      } else if (passwordFilePreexisted) {
        password = deps.passwordFileIO.read(passwordFilePath).trim();
        console.error('[quickstart] Using existing auto-generated password.');
      } else {
        password = deps.randomBytesFn(32).toString('hex');
        deps.passwordFileIO.ensureDir(jinnDir);
        deps.passwordFileIO.write(passwordFilePath, password + '\n');
        passwordGenerated = true;
        console.error('[quickstart] Generated keystore password.');
      }

      const subEnv = { ...ctx.env, JINN_PASSWORD: password };

      // ── Step 2: Init (idempotent) ──
      // From here on, any failure path between password generation and a
      // successful init must call cleanupGeneratedPasswordIfOrphaned() so a
      // failed init never strands a plaintext secret with no matching keystore.
      if (jsonProgress) {
        emitProgress(ctx.writer, { type: 'progress', phase: 'init', step: 'creating_wallet', estimatedWaitMs: 2000 });
      }
      console.error('[quickstart] Initializing wallet...');
      const initWriter = new StringWriter();
      let initExitCode: number | null = null;
      try {
        await deps.initRun({
          argv: ['--json'],
          stdoutIsTty: false,
          writer: initWriter,
          exit: (code) => { initExitCode = code; },
          env: subEnv,
        });
      } catch (err) {
        // initRun threw — keystore may or may not exist. Clean up only if it doesn't.
        const cleanup = cleanupGeneratedPasswordIfOrphaned();
        emitEnvelope({
          code: 'fatal',
          message: `init threw: ${err instanceof Error ? err.message : String(err)}`,
          exampleCli: 'jinn quickstart',
          details: { field: 'init', passwordGenerated, passwordFileCleanup: cleanup },
        }, { writer: ctx.writer, exit: ctx.exit });
        return;
      }

      if (initExitCode !== null && initExitCode !== 0) {
        console.error('[quickstart] Init failed.');
        const cleanup = cleanupGeneratedPasswordIfOrphaned();
        ctx.writer.write(initWriter.toString());
        // Emit a follow-up envelope with passwordGenerated/cleanup so callers
        // can correlate. This is appended after init's own envelope intentionally.
        ctx.writer.write(JSON.stringify({
          schemaVersion: 1,
          generatedAt: new Date().toISOString(),
          verb: 'quickstart',
          status: 'init_failed',
          passwordGenerated,
          passwordFileCleanup: cleanup,
        }) + '\n');
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
        if (jsonProgress) {
          emitProgress(ctx.writer, {
            type: 'progress',
            phase: 'bootstrap',
            step: 'advance_state_machine',
            attempt,
            estimatedWaitMs: 60_000,
          });
        }
        console.error(`[quickstart] Running bootstrap (attempt ${attempt}/${MAX_BOOTSTRAP_ATTEMPTS})...`);
        const bsWriter = new StringWriter();
        let bsExitCode: number | null = null;
        await deps.bootstrapRun({
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
          let fundingAddress: string | undefined;
          try {
            const envelope = JSON.parse(bsOutput);
            if (envelope.details?.address) {
              fundingAddress = envelope.details.address as string;
              console.error(`  Address: ${fundingAddress}`);
            }
            if (envelope.hint) {
              console.error(`  ${envelope.hint}`);
            }
          } catch { /* non-fatal */ }
          if (jsonProgress) {
            emitProgress(ctx.writer, {
              type: 'progress',
              phase: 'bootstrap',
              step: 'awaiting_funding',
              attempt,
              blocking: true,
              nextAction: 'Fund the address shown in addresses.fundingAddress, then wait for automatic retry.',
              ...(fundingAddress ? { addresses: { fundingAddress } } : {}),
              estimatedWaitMs: 1_800_000, // up to 30 min
            });
          }
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
            await deps.bootstrapRun({
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
      const apiPort = String(config.apiPort);
      const keystoreFile = keystoreFilePath;
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
          passwordGenerated,
        }) + '\n');
        return;
      }

      // ── Step 5: Start daemon (foreground) ──
      if (jsonProgress) {
        emitProgress(ctx.writer, { type: 'progress', phase: 'daemon', step: 'starting', estimatedWaitMs: 5000 });
      }
      console.error('Starting daemon...');

      // Route console to stderr for daemon (same as run command does)
      // environment plumbing for the spawned daemon — out of DI scope
      const stderrWriter = (line: string): void => {
        process.stderr.write(line.endsWith('\n') ? line : `${line}\n`);
      };
      console.log = (...args: unknown[]) => stderrWriter(args.map(String).join(' '));
      console.info = (...args: unknown[]) => stderrWriter(args.map(String).join(' '));
      console.warn = (...args: unknown[]) => stderrWriter(args.map(String).join(' '));
      console.error = (...args: unknown[]) => stderrWriter(args.map(String).join(' '));

      // Set password in process env so main.ts can read it
      // environment plumbing for the spawned daemon — out of DI scope
      process.env['JINN_PASSWORD'] = password;

      const payload = await deps.mainFn();
      ctx.writer.write(JSON.stringify(payload) + '\n');
    },
  };
}

const command: CommandModule = createQuickstartCommand();
export default command;
