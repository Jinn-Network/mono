/**
 * `jinn harnesses list|add|remove` — operator-facing CLI for managing
 * config-declared external Harnesses (Path 2 plug-in surface).
 *
 * `add <manifest-uri-or-path>`: verifies the package's `jinn.manifest.json`
 * against the operator's `trustedImplSigners`, and appends an
 * `ExternalImplEntry` to `harnesses.externalImpls` in the config file.
 *
 * `list`: prints the configured entries.
 * `remove <name>`: drops the named entry from the config file.
 *
 * Spec: `spec/2026-04-30-plug-in-surface.md` §3 / plan
 * `docs/superpowers/plans/2026-04-30-plug-in-surface-path-2-foundation.md`
 * task 7.
 */

import { parseArgs } from 'node:util';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, resolve, join } from 'node:path';
import { homedir } from 'node:os';
import type { CommandContext, CommandModule } from '../command.js';
import { loadConfig } from '../../config.js';
import { buildHarnesses } from '../../harnesses/impls/index.js';
import { harnessNameMatches } from '../../harnesses/names.js';
import {
  loadManifest,
  verifyManifestSignature,
} from '../../harnesses/manifest/index.js';
import { verifyPackageHash } from '../../harnesses/external-impls/package-hash.js';
import { writeModeState } from '../../harnesses/mode-state.js';

const DEFAULT_CONFIG_PATH = join(homedir(), '.jinn-client', 'config.json');

interface ExternalImplEntry {
  name: string;
  entry: string;
  package?: string;
}

interface SignerTrust {
  alg: 'ed25519';
  publicKey: string;
  label?: string;
}

interface ConfigShape {
  harnesses?: { externalImpls?: ExternalImplEntry[]; [k: string]: unknown };
  trustedImplSigners?: SignerTrust[];
  [k: string]: unknown;
}

function readConfigFile(path: string): ConfigShape {
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, 'utf-8')) as ConfigShape;
  } catch {
    return {};
  }
}

function writeConfigFile(path: string, cfg: ConfigShape): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, JSON.stringify(cfg, null, 2) + '\n', 'utf-8');
}

function emitJson(ctx: CommandContext, payload: unknown): void {
  ctx.writer.write(JSON.stringify(payload) + '\n');
}

function emitError(
  ctx: CommandContext,
  code: string,
  message: string,
  details?: Record<string, unknown>,
): void {
  emitJson(ctx, { error: { code, message, ...(details ? { details } : {}) } });
  ctx.exit(1);
}

function enableArgs(argv: string[]): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (!arg.startsWith('--')) continue;
    const stripped = arg.slice(2);
    const eq = stripped.indexOf('=');
    const key = eq >= 0 ? stripped.slice(0, eq) : stripped;
    if (key === 'config' || key === 'json' || key === 'human') {
      if (eq < 0 && key === 'config') i += 1;
      continue;
    }
    out[key] = eq >= 0
      ? stripped.slice(eq + 1)
      : argv[i + 1] && !argv[i + 1]!.startsWith('--')
        ? argv[++i]
        : '';
  }
  return out;
}

// ---------------------------------------------------------------------------
// list
// ---------------------------------------------------------------------------

function runList(ctx: CommandContext, configPath: string): void {
  const cfg = readConfigFile(configPath);
  const entries = cfg.harnesses?.externalImpls ?? [];
  emitJson(ctx, { verb: 'harnesses list', configPath, entries });
}

// ---------------------------------------------------------------------------
// add
// ---------------------------------------------------------------------------

async function runAdd(
  ctx: CommandContext,
  configPath: string,
  pkgPath: string,
): Promise<void> {
  const absPkg = isAbsolute(pkgPath) ? pkgPath : resolve(process.cwd(), pkgPath);
  const manifestPath = join(absPkg, 'jinn.manifest.json');
  if (!existsSync(manifestPath)) {
    emitError(ctx, 'manifest_not_found', `No jinn.manifest.json at ${absPkg}`, {
      packagePath: absPkg,
    });
    return;
  }

  let manifest;
  try {
    manifest = await loadManifest(manifestPath);
  } catch (err) {
    emitError(ctx, 'manifest_invalid', (err as Error).message, {
      manifestPath,
    });
    return;
  }

  const cfg = readConfigFile(configPath);
  const trusted = cfg.trustedImplSigners ?? [];
  const ok = await verifyManifestSignature(manifest, trusted);
  if (!ok) {
    emitError(
      ctx,
      'untrusted_signer',
      `Manifest is not signed by any key in trustedImplSigners. ` +
        `Add the publisher's public key (${manifest.signature.publicKey.slice(0, 20)}…) ` +
        `to trustedImplSigners[] first.`,
      { manifestPublicKey: manifest.signature.publicKey },
    );
    return;
  }

  // Recompute the package-content hash and compare to manifest.package.hash
  // before mutating the operator's config. Catches install-time mismatches
  // (Finding 2) so the daemon never starts with a stale entry.
  const hashOk = await verifyPackageHash(absPkg, manifest);
  if (!hashOk) {
    emitError(
      ctx,
      'package_hash_mismatch',
      `Recomputed package hash does not match manifest.package.hash (${manifest.package.hash}). ` +
        `Re-publish the package or pull the matching tarball.`,
      { manifestHash: manifest.package.hash, packagePath: absPkg },
    );
    return;
  }

  const list: ExternalImplEntry[] = [...(cfg.harnesses?.externalImpls ?? [])];
  if (list.some((e) => e.name === manifest.name)) {
    emitError(ctx, 'already_added', `Entry ${manifest.name} already present`, {
      name: manifest.name,
    });
    return;
  }
  list.push({ name: manifest.name, entry: absPkg });
  cfg.harnesses = { ...(cfg.harnesses ?? {}), externalImpls: list };
  writeConfigFile(configPath, cfg);
  emitJson(ctx, {
    verb: 'harnesses add',
    added: { name: manifest.name, entry: absPkg, version: manifest.version },
    configPath,
  });
}

// ---------------------------------------------------------------------------
// remove
// ---------------------------------------------------------------------------

function runRemove(ctx: CommandContext, configPath: string, name: string): void {
  const cfg = readConfigFile(configPath);
  const list = cfg.harnesses?.externalImpls ?? [];
  const idx = list.findIndex((e) => e.name === name);
  if (idx < 0) {
    emitError(ctx, 'not_found', `No external Harness named ${name} in config`, {
      name,
    });
    return;
  }
  const next = list.filter((_, i) => i !== idx);
  cfg.harnesses = { ...(cfg.harnesses ?? {}), externalImpls: next };
  writeConfigFile(configPath, cfg);
  emitJson(ctx, { verb: 'harnesses remove', removed: name, configPath });
}

// ---------------------------------------------------------------------------
// enable
// ---------------------------------------------------------------------------

async function runEnable(ctx: CommandContext, configPath: string, name: string): Promise<void> {
  const loaded = loadConfig(configPath);
  const harness = buildHarnesses({
    stub: true,
    rpcUrl: loaded.rpcUrl,
    archiveRpcUrl: loaded.archiveRpcUrl,
    claudePath: loaded.claudePath,
    claudeModel: loaded.claudeModel,
    implStateDirRoot: loaded.engine.implStateDirRoot,
    ipfsRegistryUrl: loaded.ipfsRegistryUrl,
  }).find((candidate) => harnessNameMatches(candidate.name, name));

  if (!harness) {
    emitError(ctx, 'unknown_harness', `Unknown Harness: ${name}`, { name });
    return;
  }
  if (!harness.onEnable) {
    emitError(ctx, 'not_enableable', `Harness ${name} does not expose an enable flow`, { name });
    return;
  }

  const enableResult = await harness.onEnable({
    runtimePlugins: [],
    args: enableArgs(ctx.argv.slice(1)),
  });
  emitJson(ctx, {
    verb: 'harnesses enable',
    configPath,
    name,
    enableResult,
  });
}

// ---------------------------------------------------------------------------
// mode
// ---------------------------------------------------------------------------

function runMode(ctx: CommandContext, configPath: string, mode: string): void {
  if (mode !== 'train' && mode !== 'frozen') {
    emitError(ctx, 'invalid_invocation', `Invalid mode "${mode}". Expected 'train' or 'frozen'.`);
    return;
  }
  const cfg = readConfigFile(configPath);
  cfg.harness = { ...(cfg.harness ?? {}), mode: mode as 'train' | 'frozen' };
  writeConfigFile(configPath, cfg);
  // Persist mode-switch metadata for the dashboard's HarnessStatusPanel.
  // Best-effort; failures are non-fatal — the config write above is the source of truth.
  try {
    writeModeState({ mode: mode as 'train' | 'frozen', switchedAt: Date.now() });
  } catch {
    // ignore — status panel falls back to lastModeSwitchAt: undefined
  }
  emitJson(ctx, { verb: 'harness mode', mode, configPath });
}

// ---------------------------------------------------------------------------
// status
// ---------------------------------------------------------------------------

function runStatus(ctx: CommandContext, configPath: string): void {
  const cfg = readConfigFile(configPath);
  const mode = (cfg.harness as any)?.mode ?? 'train';
  ctx.writer.write('harness:\n');
  ctx.writer.write(`  mode: ${mode}\n`);
}

// ---------------------------------------------------------------------------
// dispatcher
// ---------------------------------------------------------------------------

const HELP_TEXT = `\
jinn harnesses <list|add|remove|enable|mode|status> [options]

Manage operator-supplied external Harnesses (Path 2 plug-in surface), first-party Harness setup, and harness mode.

Subcommands:
  list                   Print configured external Harnesses
  add <pkg-path>         Verify a package's jinn.manifest.json against
                         trustedImplSigners[] and append the entry to
                         harnesses.externalImpls in the config file
  remove <name>          Drop the named entry from the config file
  enable <name>          Run a first-party Harness's idempotent setup flow
                         (for example Docker/Python checks for evaluators)
  mode <train|frozen>    Set harness mode (train=default allows learning,
                         frozen=stable codeDigest for benchmarking)
  status                 Print harness configuration

Options:
  --config <path>        Path to config file (default: ~/.jinn-client/config.json)
  --json                 JSON output (default for list/add/remove; not used for status)

Examples:
  jinn harnesses list
  jinn harnesses add ./node_modules/@example/forecaster
  jinn harnesses remove @example/forecaster
  jinn harnesses enable swe-rebench-v2-evaluator
  jinn harnesses mode frozen
  jinn harnesses status
`;

async function run(ctx: CommandContext): Promise<void> {
  const sub = ctx.argv[0];
  if (!sub || sub === '--help' || sub === '-h') {
    ctx.writer.write(HELP_TEXT);
    return;
  }

  let parsed;
  try {
    parsed = parseArgs({
      args: ctx.argv.slice(1),
      options: {
        config: { type: 'string' as const },
        json: { type: 'boolean' as const, default: true },
      },
      allowPositionals: true,
      strict: false,
    });
  } catch (err) {
    emitError(ctx, 'invalid_invocation', (err as Error).message);
    return;
  }

  const configPath =
    typeof parsed.values.config === 'string' && parsed.values.config.length > 0
      ? parsed.values.config
      : DEFAULT_CONFIG_PATH;

  switch (sub) {
    case 'list':
      runList(ctx, configPath);
      return;
    case 'add': {
      const pkgPath = parsed.positionals[0];
      if (!pkgPath) {
        emitError(ctx, 'invalid_invocation', 'usage: jinn harnesses add <pkg-path>');
        return;
      }
      await runAdd(ctx, configPath, pkgPath);
      return;
    }
    case 'remove': {
      const name = parsed.positionals[0];
      if (!name) {
        emitError(ctx, 'invalid_invocation', 'usage: jinn harnesses remove <name>');
        return;
      }
      runRemove(ctx, configPath, name);
      return;
    }
    case 'enable': {
      const name = parsed.positionals[0];
      if (!name) {
        emitError(ctx, 'invalid_invocation', 'usage: jinn harnesses enable <name>');
        return;
      }
      await runEnable(ctx, configPath, name);
      return;
    }
    case 'mode': {
      const mode = parsed.positionals[0];
      if (!mode) {
        emitError(ctx, 'invalid_invocation', 'usage: jinn harnesses mode <train|frozen>');
        return;
      }
      runMode(ctx, configPath, mode);
      return;
    }
    case 'status':
      runStatus(ctx, configPath);
      return;
    default:
      emitError(
        ctx,
        'invalid_invocation',
        `Unknown harnesses subcommand: ${sub} (expected list|add|remove|enable|mode|status)`,
      );
      return;
  }
}

const command: CommandModule = {
  name: 'harnesses',
  summary: 'Manage operator-supplied external Harnesses',
  helpText: HELP_TEXT,
  run,
};

export default command;

// ---------------------------------------------------------------------------
// Named exports for direct consumption by tests + other modules
// ---------------------------------------------------------------------------

/**
 * Named export for direct consumption by tests + other modules.
 * Wraps the internal runMode dispatcher with a focused signature.
 *
 * Spec: docs/superpowers/specs/2026-05-06-agent-harness-solvernet-design.md §6
 */
export async function harnessModeCommand(opts: {
  mode: 'train' | 'frozen';
  configPath: string;
}): Promise<void> {
  // Create a minimal mock CommandContext to pass to runMode
  const mockCtx: CommandContext = {
    argv: [],
    stdoutIsTty: false,
    writer: {
      write: () => true, // Return true to indicate successful write
    },
    exit: () => {
      // silent in library mode
    },
    env: process.env,
  };
  runMode(mockCtx, opts.configPath, opts.mode);
}

/**
 * Named export for direct consumption by tests + other modules.
 * Wraps the internal runStatus dispatcher with a focused signature.
 *
 * Spec: docs/superpowers/specs/2026-05-06-agent-harness-solvernet-design.md §6
 */
export async function harnessStatusCommand(opts: {
  configPath: string;
  log?: (s: string) => void;
}): Promise<void> {
  // Create a minimal mock CommandContext to pass to runStatus
  const mockCtx: CommandContext = {
    argv: [],
    stdoutIsTty: false,
    writer: {
      write: (s: string) => {
        if (opts.log) opts.log(s);
        return true; // Return true to indicate successful write
      },
    },
    exit: () => {
      // silent in library mode
    },
    env: process.env,
  };
  runStatus(mockCtx, opts.configPath);
}
