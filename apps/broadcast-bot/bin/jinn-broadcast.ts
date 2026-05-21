#!/usr/bin/env node
import { resolve } from 'node:path';
import { loadConfig } from '../src/config.js';
import { runOnce } from '../src/run-once.js';

const USAGE = `Usage: jinn-broadcast <command> [options]

Commands:
  run-once   Run a single broadcast pass and exit (the cron entry point).

Options:
  --config <path>   Path to broadcast-bot.toml (required).
  --state  <path>   Path to state JSON file (default: ./state.json).
  --dry-run         Override poster.dry_run = true (no posting).
  --help            Show this message.

Environment:
  X_API_KEY, X_API_SECRET, X_ACCESS_TOKEN, X_ACCESS_TOKEN_SECRET   X poster auth.
  CLAUDE_CODE_OAUTH_TOKEN | ANTHROPIC_API_KEY                       Claude CLI auth (composer).
  GITHUB_TOKEN                                                      Optional, raises rate limits.
  JINN_RPC_URL                                                      Overrides onchain.rpc_url.
`;

async function main(argv: string[]): Promise<number> {
  const args = parseArgs(argv);
  if (args.help || !args.command) {
    process.stdout.write(USAGE);
    return args.help ? 0 : 2;
  }
  if (args.command !== 'run-once') {
    process.stderr.write(`unknown command: ${args.command}\n${USAGE}`);
    return 2;
  }
  if (!args.config) {
    process.stderr.write(`--config is required\n${USAGE}`);
    return 2;
  }

  const config = loadConfig(resolve(args.config));
  if (args.dryRun) config.poster.dryRun = true;
  const statePath = resolve(args.state ?? './state.json');

  const summary = await runOnce({ config, statePath });
  console.log(
    `[broadcast-bot] done. posted=${summary.posted} skipped=${summary.skipped} lint_failures=${summary.lintFailures.length}`,
  );
  if (summary.lintFailures.length) {
    for (const f of summary.lintFailures) {
      console.log(`  lint-fail ${f.dedupeKey}: ${f.reason}`);
    }
  }
  return 0;
}

interface ParsedArgs {
  command?: string;
  config?: string;
  state?: string;
  dryRun: boolean;
  help: boolean;
}

function parseArgs(argv: string[]): ParsedArgs {
  const args: ParsedArgs = { dryRun: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') args.help = true;
    else if (a === '--dry-run') args.dryRun = true;
    else if (a === '--config') args.config = argv[++i];
    else if (a === '--state') args.state = argv[++i];
    else if (!a.startsWith('--') && !args.command) args.command = a;
  }
  return args;
}

main(process.argv.slice(2))
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error(`[broadcast-bot] fatal: ${(err as Error).message}`);
    if (process.env['DEBUG']) console.error(err);
    process.exit(1);
  });
