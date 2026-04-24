/**
 * `jinn register-source-bundle` — one-off operator setup to register an
 * ERC-8004 adw:SourceBundle entity for a published release.
 *
 * Typically invoked after `yarn build` + an IPFS pin of the source tarball,
 * with measurement produced by the reproducible-build pipeline.
 *
 * Scope §3.1 K4: "Source bundle is a first-class ERC-8004 entity — registered
 * once per release, referenced by every envelope from that build."
 */

import { z } from 'zod';
import { parseArgs } from 'node:util';
import { COMMON_FLAGS, type CommandContext, type CommandModule } from '../command.js';
import { emitEnvelope } from '../../errors/envelope.js';
import { emitResult } from '../output.js';
import { loadConfig, getConfigPathFromArgs } from '../../config.js';
import { Registry8004 } from '../../discovery/registry.js';
import type { SourceBundleMetadata } from '../../discovery/metadata-schemas.js';

// ── Pure function (testable without CLI context) ─────────────────────────────

const ArgsSchema = z.object({
  cid: z.string().min(1, 'bundleCid is required'),
  measurement: z
    .string()
    .regex(/^0x[0-9a-fA-F]+$/, 'measurement must be a 0x-prefixed hex string'),
  buildRecipeKind: z.enum(['dockerfile', 'nix', 'bazel'] as const),
  publishedBy: z
    .string()
    .regex(/^0x[0-9a-fA-F]{40}$/, 'publishedBy must be a 0x-prefixed 20-byte address'),
  humanUrl: z.string().optional(),
});

export type RegisterSourceBundleArgs = z.infer<typeof ArgsSchema>;

export interface RegisterSourceBundleDeps {
  registry: Pick<Registry8004, 'registerSourceBundle'>;
}

export interface RegisterSourceBundleResult {
  registeredAtBlock: bigint;
  bundleCid: string;
}

export async function runRegisterSourceBundle(
  rawArgs: unknown,
  deps: RegisterSourceBundleDeps,
): Promise<RegisterSourceBundleResult> {
  const args = ArgsSchema.parse(rawArgs);
  const block = await deps.registry.registerSourceBundle({
    bundleCid: args.cid,
    measurement: args.measurement,
    buildRecipeKind: args.buildRecipeKind as SourceBundleMetadata['buildRecipeKind'],
    publishedBy: args.publishedBy,
    ...(args.humanUrl ? { humanUrl: args.humanUrl } : {}),
  });
  return { registeredAtBlock: block, bundleCid: args.cid };
}

// ── CLI verb (CommandModule) ─────────────────────────────────────────────────

async function run(ctx: CommandContext): Promise<void> {
  let parsed;
  try {
    parsed = parseArgs({
      args: ctx.argv,
      options: {
        ...COMMON_FLAGS,
        cid: { type: 'string' },
        measurement: { type: 'string' },
        'build-recipe-kind': { type: 'string' },
        'published-by': { type: 'string' },
        'human-url': { type: 'string' },
      },
      allowPositionals: false,
    });
  } catch (err) {
    emitEnvelope(
      {
        code: 'invalid_invocation',
        message: err instanceof Error ? err.message : String(err),
        exampleCli:
          'jinn register-source-bundle --cid bafy... --measurement 0x... --build-recipe-kind dockerfile --published-by 0x...',
        details: { field: 'flags' },
      },
      { writer: ctx.writer, exit: ctx.exit },
    );
    return;
  }

  const v = parsed.values;

  if (!v.cid) {
    emitEnvelope(
      {
        code: 'invalid_invocation',
        message: '--cid is required',
        exampleCli: 'jinn register-source-bundle --cid bafy... --measurement 0x... --build-recipe-kind dockerfile --published-by 0x...',
        details: { field: '--cid', expected: 'non-empty IPFS CID string' },
      },
      { writer: ctx.writer, exit: ctx.exit },
    );
    return;
  }

  if (!v.measurement) {
    emitEnvelope(
      {
        code: 'invalid_invocation',
        message: '--measurement is required',
        exampleCli: 'jinn register-source-bundle --cid bafy... --measurement 0x... --build-recipe-kind dockerfile --published-by 0x...',
        details: { field: '--measurement', expected: '0x-prefixed hex string' },
      },
      { writer: ctx.writer, exit: ctx.exit },
    );
    return;
  }

  if (!v['build-recipe-kind']) {
    emitEnvelope(
      {
        code: 'invalid_invocation',
        message: '--build-recipe-kind is required',
        exampleCli: 'jinn register-source-bundle --cid bafy... --measurement 0x... --build-recipe-kind dockerfile --published-by 0x...',
        details: { field: '--build-recipe-kind', expected: 'dockerfile | nix | bazel' },
      },
      { writer: ctx.writer, exit: ctx.exit },
    );
    return;
  }

  if (!v['published-by']) {
    emitEnvelope(
      {
        code: 'invalid_invocation',
        message: '--published-by is required',
        exampleCli: 'jinn register-source-bundle --cid bafy... --measurement 0x... --build-recipe-kind dockerfile --published-by 0x...',
        details: { field: '--published-by', expected: '0x-prefixed 20-byte address' },
      },
      { writer: ctx.writer, exit: ctx.exit },
    );
    return;
  }

  const config = loadConfig(getConfigPathFromArgs(ctx.argv));

  if (!config.identityRegistryAddress) {
    emitEnvelope(
      {
        code: 'invalid_invocation',
        message: 'identityRegistryAddress is not configured',
        hint: 'Set identityRegistryAddress in your config file or via JINN_IDENTITY_REGISTRY_ADDRESS',
        exampleCli: 'jinn register-source-bundle --cid bafy... --measurement 0x... --build-recipe-kind dockerfile --published-by 0x...',
        details: { field: 'identityRegistryAddress' },
      },
      { writer: ctx.writer, exit: ctx.exit },
    );
    return;
  }

  // Require the private key from env (same pattern as other commands that sign txs)
  const privateKey = ctx.env['JINN_IDENTITY_REGISTRY_PK'] ?? ctx.env['JINN_AGENT_PRIVATE_KEY'];
  if (!privateKey) {
    emitEnvelope(
      {
        code: 'invalid_invocation',
        message: 'JINN_IDENTITY_REGISTRY_PK (or JINN_AGENT_PRIVATE_KEY) is required for on-chain registration',
        hint: 'Set JINN_IDENTITY_REGISTRY_PK to the 0x-prefixed private key of the signing account',
        exampleCli: 'JINN_IDENTITY_REGISTRY_PK=0x... jinn register-source-bundle ...',
        details: { field: 'JINN_IDENTITY_REGISTRY_PK' },
      },
      { writer: ctx.writer, exit: ctx.exit },
    );
    return;
  }

  const chainId = config.network === 'testnet' ? 'eip155:84532' : 'eip155:8453';
  const registry = new Registry8004({
    chainId,
    contractAddress: config.identityRegistryAddress,
    privateKey,
    rpcUrl: config.rpcUrl,
  });

  let result: RegisterSourceBundleResult;
  try {
    result = await runRegisterSourceBundle(
      {
        cid: v.cid,
        measurement: v.measurement,
        buildRecipeKind: v['build-recipe-kind'],
        publishedBy: v['published-by'],
        humanUrl: v['human-url'],
      },
      { registry },
    );
  } catch (err) {
    emitEnvelope(
      {
        code: 'fatal',
        message: err instanceof Error ? err.message : String(err),
        hint: 'Check the registry address + private key and retry.',
        exampleCli: 'jinn register-source-bundle --cid bafy... --measurement 0x... --build-recipe-kind dockerfile --published-by 0x...',
        details: { cause: err instanceof Error ? err.message : String(err) },
      },
      { writer: ctx.writer, exit: ctx.exit },
    );
    return;
  }

  emitResult(
    {
      bundleCid: result.bundleCid,
      registeredAtBlock: String(result.registeredAtBlock),
    },
    (val) => {
      const r = val as { bundleCid: string; registeredAtBlock: string };
      return `Registered source bundle ${r.bundleCid} at block ${r.registeredAtBlock}`;
    },
    { writer: ctx.writer, stdoutIsTty: ctx.stdoutIsTty, json: Boolean(v.json) },
  );
}

const registerSourceBundleCommand: CommandModule = {
  name: 'register-source-bundle',
  summary: 'Register an adw:SourceBundle on the ERC-8004 Identity Registry (one-off per release)',
  helpText: `
Usage: jinn register-source-bundle --cid <cid> --measurement <hex> --build-recipe-kind <kind> --published-by <address>

Options:
  --cid                  IPFS CID of the source tarball
  --measurement          0x-prefixed hex measurement (e.g. MRENCLAVE from TEE)
  --build-recipe-kind    Build system: dockerfile | nix | bazel
  --published-by         0x-prefixed address (20 bytes) of the signing Safe
  --human-url            (optional) Human-readable source URL (GitHub tag, etc.)
  --json                 Emit JSON output
  --config               Config file path (default: ~/.jinn-client/config.json)

Environment:
  JINN_IDENTITY_REGISTRY_PK   Private key for signing the registration tx

Examples:
  jinn register-source-bundle \\
    --cid bafybeig... \\
    --measurement 0xdeadbeef... \\
    --build-recipe-kind dockerfile \\
    --published-by 0x1234...
`.trim(),
  run,
};

export default registerSourceBundleCommand;
