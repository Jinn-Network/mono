# Client Surface 02 — CLI Scaffold + Lifecycle Verbs Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the `jinn` command-line binary with dispatch scaffold and the seven lifecycle verbs: `init`, `doctor`, `bootstrap`, `fund-requirements`, `run`, `stop`, `version`. Every verb conforms to the contract in `spec/2026-04-14-client-surface.md` — headless-first, JSON-by-default on non-TTY, error envelope on non-zero exit.

**Architecture:** A thin POSIX shell wrapper at `client/bin/jinn` execs `tsx` on `client/bin/jinn.ts`, which imports the dispatch entry from `client/src/cli/index.ts`. The dispatcher uses Node's built-in `util.parseArgs` (zero dependency, ships in Node ≥ 18.11), hands control to a command module in `client/src/cli/commands/<verb>.ts`, and unifies output through `client/src/cli/output.ts` so every verb emits JSON on non-TTY automatically and respects `NO_COLOR` otherwise.

**Tech Stack:** TypeScript, Vitest, Node `util.parseArgs`, existing envelope module from plan 01, existing `FleetBootstrapper` / `Daemon` / `ClaudeRunner`.

**Hard prerequisite:** Plan 01 (`2026-04-14-client-surface-01-envelope.md`) must be fully implemented and committed before starting this plan. This plan imports `emitEnvelope`, `EXIT_CODES`, `ErrorEnvelope` from `client/src/errors/envelope.js` and `checkClaudeBinary` from `client/src/preflight/claude-binary.js`. If those files don't exist, stop and run plan 01 first.

**Reference:** `spec/2026-04-14-client-surface.md` §2.1 (lifecycle verbs), §4 (JSON shapes), §6 (error envelope), §7 (behavioral rules). The spec is the source of truth.

**Non-goals for this plan:**
- Introspection verbs (`status`, `fleet`, `balance`, `history`, `rewards`, `logs`) — covered by plan 03.
- Action verbs (`submit-intent`, `claim-rewards`, `fleet scale`, `fleet retire`, `withdraw`, `keys backup`) — covered by plan 04.
- Retiring `npm run start` / `npm run status` / `npm run withdraw` — those coexist with the CLI until a later plan.

---

## File structure

New files (dispatch + helpers):
- `client/bin/jinn` — POSIX shell wrapper; `exec`s `tsx` on `jinn.ts`. Executable bit set.
- `client/bin/jinn.ts` — Thin entry that calls `runCli(process.argv.slice(2))`.
- `client/src/cli/index.ts` — `runCli(argv)` — parses top-level verb + `--help` / `--version`, dispatches to command modules.
- `client/src/cli/output.ts` — `isJsonMode()`, `writeJson(value)`, `writeHuman(s)`, `NO_COLOR` handling.
- `client/src/cli/help.ts` — Per-verb `--help` rendering with copy-pasteable Examples.
- `client/src/cli/command.ts` — `CommandModule` interface, shared flag parser helpers (e.g. `parseCommonFlags`).

New files (one per verb):
- `client/src/cli/commands/version.ts`
- `client/src/cli/commands/doctor.ts`
- `client/src/cli/commands/bootstrap.ts`
- `client/src/cli/commands/fund-requirements.ts`
- `client/src/cli/commands/init.ts`
- `client/src/cli/commands/run.ts`
- `client/src/cli/commands/stop.ts`

New tests (one per verb + dispatch):
- `client/test/cli/index.test.ts`
- `client/test/cli/output.test.ts`
- `client/test/cli/commands/version.test.ts`
- `client/test/cli/commands/doctor.test.ts`
- `client/test/cli/commands/bootstrap.test.ts`
- `client/test/cli/commands/fund-requirements.test.ts`
- `client/test/cli/commands/init.test.ts`
- `client/test/cli/commands/run.test.ts`
- `client/test/cli/commands/stop.test.ts`

Modified files:
- `client/package.json` — add `"bin": { "jinn": "./bin/jinn" }` and `"scripts": { "jinn": "tsx bin/jinn.ts" }`.

---

## Task 1: Shell wrapper + dev-mode tsx entry

**Files:**
- Create: `client/bin/jinn`
- Create: `client/bin/jinn.ts`
- Modify: `client/package.json`

- [ ] **Step 1: Create the POSIX shell wrapper**

Create `client/bin/jinn` with:

```sh
#!/usr/bin/env sh
# Thin launcher: exec tsx on the TypeScript entry living next to this file.
# Works when the client is installed via `npm install` (the package.json `bin`
# field creates a symlink to this script).
DIR="$(cd "$(dirname "$0")" && pwd)"
exec tsx "$DIR/jinn.ts" "$@"
```

- [ ] **Step 2: Make the wrapper executable**

Run:
```bash
chmod +x client/bin/jinn
```

- [ ] **Step 3: Create the TypeScript entry**

Create `client/bin/jinn.ts`:

```typescript
#!/usr/bin/env tsx
/**
 * jinn CLI entry. Delegates to client/src/cli/index.ts.
 *
 * Contract: spec/2026-04-14-client-surface.md
 */

import { runCli } from '../src/cli/index.js';

runCli(process.argv.slice(2)).catch((err) => {
  // Top-level safety net. runCli is expected to catch its own errors
  // and emit an envelope, so reaching here is itself a defect.
  // Log to stderr; the envelope contract requires stdout.
  console.error('[jinn] internal error: runCli threw instead of emitting an envelope');
  console.error(err);
  process.exit(50);
});
```

- [ ] **Step 4: Wire the package.json bin and script**

In `client/package.json`, find:

```json
  "scripts": {
    "build": "tsc",
```

Add a `jinn` script above `build`:

```json
  "bin": {
    "jinn": "./bin/jinn"
  },
  "scripts": {
    "jinn": "tsx bin/jinn.ts",
    "build": "tsc",
```

(The resulting file should have `bin` as a top-level key and `scripts.jinn` as the first script.)

- [ ] **Step 5: Commit**

```bash
git add client/bin/jinn client/bin/jinn.ts client/package.json
git commit -m "client(cli): scaffold jinn binary entry with tsx launcher"
```

---

## Task 2: Output helpers — JSON-by-default on non-TTY

**Files:**
- Create: `client/src/cli/output.ts`
- Create: `client/test/cli/output.test.ts`

- [ ] **Step 1: Write the failing test**

Create `client/test/cli/output.test.ts`:

```typescript
import { describe, expect, it } from 'vitest';
import { isJsonMode, formatJson, formatHuman } from '../../src/cli/output.js';

describe('isJsonMode', () => {
  it('is true when --json is in flags', () => {
    expect(isJsonMode({ json: true, stdoutIsTty: true })).toBe(true);
  });

  it('is true when stdout is not a TTY', () => {
    expect(isJsonMode({ json: false, stdoutIsTty: false })).toBe(true);
  });

  it('is false when stdout is a TTY and --json is not set', () => {
    expect(isJsonMode({ json: false, stdoutIsTty: true })).toBe(false);
  });
});

describe('formatJson', () => {
  it('emits a single line ending in newline', () => {
    const out = formatJson({ a: 1, b: [2, 3] });
    expect(out).toBe('{"a":1,"b":[2,3]}\n');
  });
});

describe('formatHuman', () => {
  it('returns the input unchanged when NO_COLOR is not set', () => {
    expect(formatHuman('hello', { noColor: false })).toBe('hello');
  });

  it('strips ANSI escape sequences when NO_COLOR is set', () => {
    const colored = '\u001b[31mred\u001b[0m';
    expect(formatHuman(colored, { noColor: true })).toBe('red');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:
```bash
cd client && npx vitest run test/cli/output.test.ts
```

Expected: FAIL with "Cannot find module '../../src/cli/output.js'".

- [ ] **Step 3: Create the output module**

Create `client/src/cli/output.ts`:

```typescript
/**
 * CLI output helpers.
 *
 * Contract: spec/2026-04-14-client-surface.md §7.2.
 * - JSON is implicit when stdout is not a TTY.
 * - NO_COLOR strips ANSI in human mode.
 */

export interface JsonModeInput {
  json: boolean;
  stdoutIsTty: boolean;
}

export function isJsonMode(input: JsonModeInput): boolean {
  return input.json || !input.stdoutIsTty;
}

export function formatJson(value: unknown): string {
  return JSON.stringify(value) + '\n';
}

const ANSI_PATTERN = /\u001b\[[0-9;]*m/g;

export interface HumanModeOpts {
  noColor: boolean;
}

export function formatHuman(text: string, opts: HumanModeOpts): string {
  if (opts.noColor) return text.replace(ANSI_PATTERN, '');
  return text;
}

/**
 * Decide the effective output mode for a verb and write the value.
 * Production callers pass `process.stdout`; tests inject a writer.
 */
export interface EmitOpts {
  json: boolean;
  writer?: { write: (s: string) => boolean };
  stdoutIsTty?: boolean;
  noColor?: boolean;
}

export function emitResult(value: unknown, humanRender: (v: unknown) => string, opts: EmitOpts): void {
  const writer = opts.writer ?? process.stdout;
  const stdoutIsTty = opts.stdoutIsTty ?? Boolean(process.stdout.isTTY);
  const noColor = opts.noColor ?? Boolean(process.env['NO_COLOR']);
  if (isJsonMode({ json: opts.json, stdoutIsTty })) {
    writer.write(formatJson(value));
  } else {
    writer.write(formatHuman(humanRender(value), { noColor }) + '\n');
  }
}
```

- [ ] **Step 4: Run tests to verify pass**

Run:
```bash
cd client && npx vitest run test/cli/output.test.ts
```

Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add client/src/cli/output.ts client/test/cli/output.test.ts
git commit -m "client(cli): add JSON/human output helpers with NO_COLOR support"
```

---

## Task 3: Command module interface + shared flag parsing

**Files:**
- Create: `client/src/cli/command.ts`

- [ ] **Step 1: Create the command interface**

Create `client/src/cli/command.ts`:

```typescript
/**
 * Shared types and helpers for jinn CLI command modules.
 *
 * Every command module exports a default `CommandModule` object. The
 * dispatcher in cli/index.ts looks up the verb name, parses flags with
 * `parseArgs`, and calls `run`.
 */

import { parseArgs, type ParseArgsConfig } from 'node:util';

export interface CommandContext {
  /** Everything after the verb, e.g. for `jinn bootstrap --json`, this is ['--json']. */
  argv: string[];
  /** Effective stdout TTY state; tests inject false. */
  stdoutIsTty: boolean;
  /** Injected writer for tests; production uses process.stdout. */
  writer: { write: (s: string) => boolean };
  /** Injected exit for tests; production uses process.exit. */
  exit: (code: number) => void;
  /** Process environment, for JINN_PASSWORD, JINN_CLAUDE_PATH, etc. */
  env: NodeJS.ProcessEnv;
}

export interface CommandModule {
  name: string;
  summary: string;
  helpText: string; // Full --help body including Examples, rendered by help.ts
  run(ctx: CommandContext): Promise<void>;
}

/**
 * Strongly-typed wrapper around Node's parseArgs. Callers pass the command
 * name and options schema; this returns the parsed values or throws on
 * invalid flags. Callers are responsible for catching and emitting an
 * envelope with code 'invalid_invocation'.
 */
export function parseCommandArgs<T extends ParseArgsConfig['options']>(
  argv: string[],
  options: T,
): ReturnType<typeof parseArgs<{ options: T; args: string[] }>> {
  return parseArgs({ args: argv, options, allowPositionals: true });
}

/**
 * Common flags every verb accepts. Callers spread this into their options.
 */
export const COMMON_FLAGS = {
  json: { type: 'boolean' as const, default: false },
  help: { type: 'boolean' as const, default: false },
  config: { type: 'string' as const },
};
```

- [ ] **Step 2: Typecheck**

Run:
```bash
cd client && npx tsc --noEmit
```

Expected: zero errors (no tests yet — interface file has no behavior).

- [ ] **Step 3: Commit**

```bash
git add client/src/cli/command.ts
git commit -m "client(cli): define CommandModule interface and shared flag schema"
```

---

## Task 4: Help renderer

**Files:**
- Create: `client/src/cli/help.ts`
- Create: `client/test/cli/help.test.ts`

- [ ] **Step 1: Write the failing test**

Create `client/test/cli/help.test.ts`:

```typescript
import { describe, expect, it } from 'vitest';
import { renderTopLevelHelp, renderCommandHelp } from '../../src/cli/help.js';
import type { CommandModule } from '../../src/cli/command.js';

const fakeCommand: CommandModule = {
  name: 'test-verb',
  summary: 'a fake verb for tests',
  helpText: 'Usage: jinn test-verb [--flag]\n\nExamples:\n  jinn test-verb --flag\n',
  run: async () => { /* unused */ },
};

describe('renderTopLevelHelp', () => {
  it('lists every registered command with its summary', () => {
    const out = renderTopLevelHelp([fakeCommand]);
    expect(out).toContain('test-verb');
    expect(out).toContain('a fake verb for tests');
    expect(out).toContain('Usage: jinn <verb>');
  });
});

describe('renderCommandHelp', () => {
  it('prepends the verb name and summary to helpText', () => {
    const out = renderCommandHelp(fakeCommand);
    expect(out).toContain('jinn test-verb');
    expect(out).toContain('a fake verb for tests');
    expect(out).toContain('Usage: jinn test-verb');
    expect(out).toContain('Examples:');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:
```bash
cd client && npx vitest run test/cli/help.test.ts
```

Expected: FAIL with "Cannot find module '../../src/cli/help.js'".

- [ ] **Step 3: Create the help renderer**

Create `client/src/cli/help.ts`:

```typescript
import type { CommandModule } from './command.js';

export function renderTopLevelHelp(commands: CommandModule[]): string {
  const lines: string[] = [];
  lines.push('Usage: jinn <verb> [flags...]');
  lines.push('');
  lines.push('Verbs:');
  const maxNameLen = Math.max(...commands.map((c) => c.name.length));
  for (const cmd of commands) {
    lines.push(`  ${cmd.name.padEnd(maxNameLen)}  ${cmd.summary}`);
  }
  lines.push('');
  lines.push('Run `jinn <verb> --help` for verb-specific flags and examples.');
  return lines.join('\n');
}

export function renderCommandHelp(command: CommandModule): string {
  return `jinn ${command.name} — ${command.summary}\n\n${command.helpText}`;
}
```

- [ ] **Step 4: Run tests to verify pass**

Run:
```bash
cd client && npx vitest run test/cli/help.test.ts
```

Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add client/src/cli/help.ts client/test/cli/help.test.ts
git commit -m "client(cli): add top-level and per-verb help renderers"
```

---

## Task 5: `version` verb — simplest possible command to prove the pattern

**Files:**
- Create: `client/src/cli/commands/version.ts`
- Create: `client/test/cli/commands/version.test.ts`

- [ ] **Step 1: Write the failing test**

Create `client/test/cli/commands/version.test.ts`:

```typescript
import { describe, expect, it } from 'vitest';
import version from '../../../src/cli/commands/version.js';
import type { CommandContext } from '../../../src/cli/command.js';

function makeCtx(argv: string[] = []): { ctx: CommandContext; writes: string[]; exits: number[] } {
  const writes: string[] = [];
  const exits: number[] = [];
  const ctx: CommandContext = {
    argv,
    stdoutIsTty: false,
    writer: { write: (s: string) => { writes.push(s); return true; } },
    exit: (code: number) => { exits.push(code); },
    env: {},
  };
  return { ctx, writes, exits };
}

describe('version command', () => {
  it('emits a JSON object with schemaVersion, client, protocol, network, tokens', async () => {
    const { ctx, writes } = makeCtx();
    await version.run(ctx);
    expect(writes).toHaveLength(1);
    const parsed = JSON.parse(writes[0]);
    expect(parsed.schemaVersion).toBe(1);
    expect(parsed.client).toBeDefined();
    expect(parsed.client.version).toBeDefined();
    expect(parsed.protocol).toBeDefined();
    expect(parsed.protocol.specVersion).toBe(1);
    expect(parsed.network).toMatch(/^(testnet|mainnet)$/);
    expect(parsed.tokens).toBeDefined();
    expect(parsed.tokens.native).toBeDefined();
  });

  it('exits 0 and writes nothing else on success', async () => {
    const { ctx, writes, exits } = makeCtx();
    await version.run(ctx);
    expect(writes).toHaveLength(1);
    expect(exits).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:
```bash
cd client && npx vitest run test/cli/commands/version.test.ts
```

Expected: FAIL with "Cannot find module '../../../src/cli/commands/version.js'".

- [ ] **Step 3: Implement the version command**

Create `client/src/cli/commands/version.ts`:

```typescript
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { CommandContext, CommandModule } from '../command.js';
import { emitResult } from '../output.js';
import { loadConfig } from '../../config.js';
import { getChainConfig } from '../../earning/contracts.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const PACKAGE_JSON_PATH = join(HERE, '..', '..', '..', 'package.json');

function readClientVersion(): string {
  const raw = readFileSync(PACKAGE_JSON_PATH, 'utf-8');
  const pkg = JSON.parse(raw) as { version?: string };
  return pkg.version ?? '0.0.0';
}

async function run(ctx: CommandContext): Promise<void> {
  const config = loadConfig();
  const chain = config.network === 'testnet' ? 'base-sepolia' : 'base';
  const chainConfig = getChainConfig(chain, {
    testnetL2DeploymentPath: config.testnetL2DeploymentPath,
    testnetL2TokenDeploymentPath: config.testnetL2TokenDeploymentPath,
    testnetMechDeploymentPath: config.testnetMechDeploymentPath,
    testnetStolasDeploymentPath: config.testnetStolasDeploymentPath,
  });

  const payload = {
    schemaVersion: 1 as const,
    generatedAt: new Date().toISOString(),
    client: {
      version: readClientVersion(),
      commit: ctx.env['JINN_BUILD_COMMIT'] ?? 'unknown',
    },
    protocol: {
      phase: config.network === 'testnet' ? 'phase-1b' : 'phase-0',
      specVersion: 1 as const,
    },
    network: config.network,
    deployments: {
      digest: 'unknown',
      artifacts: [] as Array<{ name: string; path: string; sha256: string }>,
    },
    tokens: {
      native: { symbol: 'ETH', decimals: 18 },
      bond: { symbol: chainConfig.olasToken, address: chainConfig.olasToken, decimals: 18 },
      reward: { symbol: chainConfig.olasToken, address: chainConfig.olasToken, decimals: 18 },
    },
  };

  emitResult(payload, (v) => JSON.stringify(v, null, 2), {
    json: false,
    writer: ctx.writer,
    stdoutIsTty: ctx.stdoutIsTty,
  });
}

const command: CommandModule = {
  name: 'version',
  summary: 'Print client version, protocol phase, and resolved token map',
  helpText: `Usage: jinn version [--json]

Prints a JSON object with the client version, protocol phase, current
network, deployment artifact digests, and the resolved token-role map.
This is the only verb (together with \`jinn fund-requirements\`) that
emits concrete token symbols and addresses — everywhere else uses role
names (native / bond / reward).

Examples:
  jinn version
  jinn version --json
`,
  run,
};

export default command;
```

- [ ] **Step 4: Run tests to verify pass**

Run:
```bash
cd client && npx vitest run test/cli/commands/version.test.ts
```

Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add client/src/cli/commands/version.ts client/test/cli/commands/version.test.ts
git commit -m "client(cli): add version verb"
```

---

## Task 6: Dispatch — wire version into runCli

**Files:**
- Create: `client/src/cli/index.ts`
- Create: `client/test/cli/index.test.ts`

- [ ] **Step 1: Write the failing dispatch test**

Create `client/test/cli/index.test.ts`:

```typescript
import { describe, expect, it } from 'vitest';
import { runCli } from '../../src/cli/index.js';

function captureIo() {
  const writes: string[] = [];
  const exits: number[] = [];
  return {
    writer: { write: (s: string) => { writes.push(s); return true; } },
    exit: (code: number) => { exits.push(code); },
    writes,
    exits,
  };
}

describe('runCli', () => {
  it('dispatches `version` to the version command', async () => {
    const io = captureIo();
    await runCli(['version'], { writer: io.writer, exit: io.exit, stdoutIsTty: false });
    expect(io.writes.length).toBeGreaterThan(0);
    const parsed = JSON.parse(io.writes[io.writes.length - 1]);
    expect(parsed.schemaVersion).toBe(1);
  });

  it('emits invalid_invocation envelope and exits 11 for unknown verb', async () => {
    const io = captureIo();
    await runCli(['no-such-verb'], { writer: io.writer, exit: io.exit, stdoutIsTty: false });
    const parsed = JSON.parse(io.writes[io.writes.length - 1]);
    expect(parsed.code).toBe('invalid_invocation');
    expect(parsed.exitCode).toBe(11);
    expect(io.exits).toEqual([11]);
  });

  it('prints top-level help when invoked with no args', async () => {
    const io = captureIo();
    await runCli([], { writer: io.writer, exit: io.exit, stdoutIsTty: true });
    const combined = io.writes.join('');
    expect(combined).toContain('Usage: jinn <verb>');
    expect(combined).toContain('version');
  });

  it('prints per-verb help when invoked with --help', async () => {
    const io = captureIo();
    await runCli(['version', '--help'], { writer: io.writer, exit: io.exit, stdoutIsTty: true });
    const combined = io.writes.join('');
    expect(combined).toContain('jinn version');
    expect(combined).toContain('Examples:');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:
```bash
cd client && npx vitest run test/cli/index.test.ts
```

Expected: FAIL with "Cannot find module '../../src/cli/index.js'".

- [ ] **Step 3: Implement the dispatcher**

Create `client/src/cli/index.ts`:

```typescript
/**
 * jinn CLI dispatcher.
 *
 * Contract: spec/2026-04-14-client-surface.md §2 (verbs), §6 (error envelope),
 * §7 (behavioral rules).
 *
 * Adding a verb: create `commands/<name>.ts` exporting a default CommandModule,
 * then import and push into COMMANDS below.
 */

import type { CommandContext, CommandModule } from './command.js';
import { emitEnvelope } from '../errors/envelope.js';
import { renderTopLevelHelp, renderCommandHelp } from './help.js';

import versionCommand from './commands/version.js';

const COMMANDS: CommandModule[] = [
  versionCommand,
];

export interface RunCliOptions {
  writer?: { write: (s: string) => boolean };
  exit?: (code: number) => void;
  stdoutIsTty?: boolean;
}

export async function runCli(argv: string[], opts: RunCliOptions = {}): Promise<void> {
  const writer = opts.writer ?? process.stdout;
  const exit = opts.exit ?? ((c: number) => { process.exit(c); });
  const stdoutIsTty = opts.stdoutIsTty ?? Boolean(process.stdout.isTTY);

  // No args → top-level help, exit 0.
  if (argv.length === 0) {
    writer.write(renderTopLevelHelp(COMMANDS) + '\n');
    return;
  }

  const [verb, ...rest] = argv;

  // --help at the top level
  if (verb === '--help' || verb === '-h') {
    writer.write(renderTopLevelHelp(COMMANDS) + '\n');
    return;
  }

  const command = COMMANDS.find((c) => c.name === verb);
  if (!command) {
    emitEnvelope(
      {
        code: 'invalid_invocation',
        message: `Unknown verb: ${verb}`,
        hint: 'Run `jinn --help` for the list of verbs.',
        exampleCli: 'jinn --help',
        details: { field: 'verb', expected: COMMANDS.map((c) => c.name).join('|') },
      },
      { writer, exit },
    );
    return;
  }

  // Per-verb --help short-circuit (before any command-specific parsing)
  if (rest.includes('--help') || rest.includes('-h')) {
    writer.write(renderCommandHelp(command) + '\n');
    return;
  }

  const ctx: CommandContext = {
    argv: rest,
    stdoutIsTty,
    writer,
    exit,
    env: process.env,
  };

  try {
    await command.run(ctx);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const cause = err instanceof Error ? (err.stack ?? err.message) : String(err);
    emitEnvelope(
      {
        code: 'fatal',
        message,
        details: { verb, cause },
      },
      { writer, exit },
    );
  }
}
```

- [ ] **Step 4: Run tests to verify pass**

Run:
```bash
cd client && npx vitest run test/cli/index.test.ts
```

Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add client/src/cli/index.ts client/test/cli/index.test.ts
git commit -m "client(cli): add dispatcher wiring first verb"
```

---

## Task 7: `doctor` verb — preflight checks

**Files:**
- Create: `client/src/cli/commands/doctor.ts`
- Create: `client/test/cli/commands/doctor.test.ts`
- Modify: `client/src/cli/index.ts` (register doctor)

- [ ] **Step 1: Write the failing test**

Create `client/test/cli/commands/doctor.test.ts`:

```typescript
import { describe, expect, it } from 'vitest';
import doctor from '../../../src/cli/commands/doctor.js';
import type { CommandContext } from '../../../src/cli/command.js';

function makeCtx(env: Record<string, string> = {}): {
  ctx: CommandContext; writes: string[]; exits: number[];
} {
  const writes: string[] = [];
  const exits: number[] = [];
  const ctx: CommandContext = {
    argv: [],
    stdoutIsTty: false,
    writer: { write: (s: string) => { writes.push(s); return true; } },
    exit: (code: number) => { exits.push(code); },
    env,
  };
  return { ctx, writes, exits };
}

describe('doctor command', () => {
  it('emits a checks array and an ok/blockingCount roll-up', async () => {
    const { ctx, writes } = makeCtx();
    await doctor.run(ctx);
    expect(writes).toHaveLength(1);
    const parsed = JSON.parse(writes[0]);
    expect(parsed.schemaVersion).toBe(1);
    expect(Array.isArray(parsed.checks)).toBe(true);
    expect(parsed.checks.length).toBeGreaterThan(0);
    expect(typeof parsed.ok).toBe('boolean');
    expect(typeof parsed.blockingCount).toBe('number');
    // Every check has the required shape
    for (const check of parsed.checks) {
      expect(typeof check.name).toBe('string');
      expect(typeof check.ok).toBe('boolean');
      expect(typeof check.detail).toBe('string');
    }
  });

  it('includes the claude_binary check', async () => {
    const { ctx, writes } = makeCtx();
    await doctor.run(ctx);
    const parsed = JSON.parse(writes[0]);
    const names = parsed.checks.map((c: { name: string }) => c.name);
    expect(names).toContain('claude_binary');
    expect(names).toContain('node_version');
    expect(names).toContain('keystore_readable');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:
```bash
cd client && npx vitest run test/cli/commands/doctor.test.ts
```

Expected: FAIL with "Cannot find module".

- [ ] **Step 3: Implement the doctor command**

Create `client/src/cli/commands/doctor.ts`:

```typescript
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { CommandContext, CommandModule } from '../command.js';
import { emitResult } from '../output.js';
import { checkClaudeBinary } from '../../preflight/claude-binary.js';
import { loadConfig } from '../../config.js';

interface CheckResult {
  name: string;
  ok: boolean;
  detail: string;
  remedy?: string;
}

async function checkNodeVersion(): Promise<CheckResult> {
  const version = process.versions.node;
  const major = parseInt(version.split('.')[0], 10);
  const ok = major >= 20;
  return {
    name: 'node_version',
    ok,
    detail: `v${version}`,
    ...(ok ? {} : { remedy: 'Upgrade to Node.js 20 or newer.' }),
  };
}

async function checkKeystoreReadable(earningDir: string): Promise<CheckResult> {
  const keystorePath = join(earningDir, 'mnemonic.keystore.json');
  if (existsSync(keystorePath)) {
    return { name: 'keystore_readable', ok: true, detail: `present at ${earningDir}` };
  }
  return {
    name: 'keystore_readable',
    ok: true, // Missing is fine before `jinn init`; not a blocker.
    detail: 'no keystore yet (expected on a fresh install)',
  };
}

async function checkDeploymentLoaded(network: 'testnet' | 'mainnet'): Promise<CheckResult> {
  try {
    const chain = network === 'testnet' ? 'base-sepolia' : 'base';
    const { getChainConfig } = await import('../../earning/contracts.js');
    const cfg = getChainConfig(chain);
    const hasMech = cfg.mechMarketplace !== '0x0000000000000000000000000000000000000000';
    return {
      name: 'deployment_loaded',
      ok: hasMech,
      detail: hasMech ? `resolved on ${chain}` : 'mechMarketplace is zero address',
      ...(hasMech ? {} : { remedy: 'Set JINN_TESTNET_MECH_DEPLOYMENT or run on a network with a deployed mech.' }),
    };
  } catch (err) {
    return {
      name: 'deployment_loaded',
      ok: false,
      detail: err instanceof Error ? err.message : String(err),
      remedy: 'Check deployment artifact paths in config.',
    };
  }
}

async function run(ctx: CommandContext): Promise<void> {
  const config = loadConfig();
  const checks: CheckResult[] = [];

  checks.push(await checkNodeVersion());

  const claudeResult = await checkClaudeBinary(config.claudePath);
  checks.push({
    name: 'claude_binary',
    ok: claudeResult.ok,
    detail: claudeResult.detail,
    ...(claudeResult.ok ? {} : { remedy: 'Install Claude Code or set JINN_CLAUDE_PATH to an absolute path.' }),
  });

  checks.push(await checkKeystoreReadable(config.earningDir));
  checks.push(await checkDeploymentLoaded(config.network));

  const blockingCount = checks.filter((c) => !c.ok).length;
  const payload = {
    schemaVersion: 1 as const,
    generatedAt: new Date().toISOString(),
    checks,
    ok: blockingCount === 0,
    blockingCount,
  };

  emitResult(payload, (v) => JSON.stringify(v, null, 2), {
    json: false,
    writer: ctx.writer,
    stdoutIsTty: ctx.stdoutIsTty,
  });
}

const command: CommandModule = {
  name: 'doctor',
  summary: 'Preflight checks: answers "would jinn run work?" without running it',
  helpText: `Usage: jinn doctor [--json]

Runs a set of non-mutating checks against the local environment and
configuration:
  - node_version        Node.js >= 20
  - claude_binary       claude CLI resolvable on PATH
  - keystore_readable   ~/.jinn-client/earning keystore present (optional)
  - deployment_loaded   testnet/mainnet contract addresses resolved

Emits a JSON object with a checks array, an overall ok flag, and a
blockingCount. Exit code is 0 even when checks fail — callers read
the JSON to decide whether to proceed.

Examples:
  jinn doctor
  jinn doctor --json | jq '.ok'
`,
  run,
};

export default command;
```

- [ ] **Step 4: Register doctor in the dispatcher**

In `client/src/cli/index.ts`, find:

```typescript
import versionCommand from './commands/version.js';

const COMMANDS: CommandModule[] = [
  versionCommand,
];
```

Replace with:

```typescript
import versionCommand from './commands/version.js';
import doctorCommand from './commands/doctor.js';

const COMMANDS: CommandModule[] = [
  versionCommand,
  doctorCommand,
];
```

- [ ] **Step 5: Run tests to verify pass**

Run:
```bash
cd client && npx vitest run test/cli/commands/doctor.test.ts test/cli/index.test.ts
```

Expected: PASS (all tests in both files).

- [ ] **Step 6: Commit**

```bash
git add client/src/cli/commands/doctor.ts client/test/cli/commands/doctor.test.ts client/src/cli/index.ts
git commit -m "client(cli): add doctor verb with node/claude/keystore/deployment checks"
```

---

## Task 8: `bootstrap` verb — thin wrapper over FleetBootstrapper

**Files:**
- Create: `client/src/cli/commands/bootstrap.ts`
- Create: `client/test/cli/commands/bootstrap.test.ts`
- Modify: `client/src/cli/index.ts` (register)

- [ ] **Step 1: Write the failing test**

Create `client/test/cli/commands/bootstrap.test.ts`. Because FleetBootstrapper touches RPC, this test mocks the bootstrap module.

```typescript
import { describe, expect, it, vi } from 'vitest';
import type { CommandContext } from '../../../src/cli/command.js';

vi.mock('../../../src/earning/bootstrap.js', () => ({
  FleetBootstrapper: class {
    async bootstrap() {
      return {
        ok: false,
        funding: { master_address: '0xabc', eth_required: '1000', eth_balance: '500' },
        message: 'need more eth',
        fleet_state: { master_address: '0xabc', services: [] },
      };
    }
  },
}));

function makeCtx(env: Record<string, string> = { JINN_PASSWORD: 'test' }): {
  ctx: CommandContext; writes: string[]; exits: number[];
} {
  const writes: string[] = [];
  const exits: number[] = [];
  const ctx: CommandContext = {
    argv: [],
    stdoutIsTty: false,
    writer: { write: (s: string) => { writes.push(s); return true; } },
    exit: (code: number) => { exits.push(code); },
    env,
  };
  return { ctx, writes, exits };
}

describe('bootstrap command', () => {
  it('emits funding_required envelope and exits 10 when bootstrap returns funding', async () => {
    const { default: bootstrap } = await import('../../../src/cli/commands/bootstrap.js');
    const { ctx, writes, exits } = makeCtx();
    await bootstrap.run(ctx);
    const parsed = JSON.parse(writes[writes.length - 1]);
    expect(parsed.code).toBe('funding_required');
    expect(parsed.exitCode).toBe(10);
    expect(exits).toEqual([10]);
  });

  it('emits invalid_invocation exit 11 when JINN_PASSWORD is missing', async () => {
    const { default: bootstrap } = await import('../../../src/cli/commands/bootstrap.js');
    const { ctx, writes, exits } = makeCtx({});
    await bootstrap.run(ctx);
    const parsed = JSON.parse(writes[writes.length - 1]);
    expect(parsed.code).toBe('invalid_invocation');
    expect(parsed.exitCode).toBe(11);
    expect(parsed.details?.field).toBe('JINN_PASSWORD');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:
```bash
cd client && npx vitest run test/cli/commands/bootstrap.test.ts
```

Expected: FAIL with "Cannot find module".

- [ ] **Step 3: Implement the bootstrap command**

Create `client/src/cli/commands/bootstrap.ts`:

```typescript
import type { CommandContext, CommandModule } from '../command.js';
import { emitEnvelope } from '../../errors/envelope.js';
import { loadConfig } from '../../config.js';
import { FleetBootstrapper } from '../../earning/bootstrap.js';
import { formatBootstrapOperatorMessage } from '../../operator-errors.js';

async function run(ctx: CommandContext): Promise<void> {
  const password = ctx.env['JINN_PASSWORD'];
  if (!password) {
    emitEnvelope(
      {
        code: 'invalid_invocation',
        message: 'JINN_PASSWORD is required to encrypt/decrypt the keystore.',
        hint: 'Set JINN_PASSWORD in the environment before running jinn bootstrap.',
        exampleCli: 'JINN_PASSWORD=... jinn bootstrap',
        details: { field: 'JINN_PASSWORD', expected: 'non-empty string' },
      },
      { writer: ctx.writer, exit: ctx.exit },
    );
    return;
  }

  const config = loadConfig();
  const bootstrapper = new FleetBootstrapper({
    earningDir: config.earningDir,
    chain: config.network === 'testnet' ? 'base-sepolia' : 'base',
    rpcUrl: config.rpcUrl,
    stakingMode: config.stakingMode,
    targetServices: config.targetServices,
    testnetL2DeploymentPath: config.testnetL2DeploymentPath,
    testnetL2TokenDeploymentPath: config.testnetL2TokenDeploymentPath,
    testnetMechDeploymentPath: config.testnetMechDeploymentPath,
    testnetStolasDeploymentPath: config.testnetStolasDeploymentPath,
    debug: config.debug,
    pollIntervalMs: config.pollIntervalMs,
  });

  let result: Awaited<ReturnType<FleetBootstrapper['bootstrap']>>;
  try {
    result = await bootstrapper.bootstrap(password);
  } catch (err) {
    const { summary, hint } = formatBootstrapOperatorMessage(err);
    const cause = err instanceof Error ? (err.stack ?? err.message) : String(err);
    emitEnvelope(
      {
        code: 'fatal',
        message: summary,
        ...(hint !== undefined ? { hint } : {}),
        details: { stage: 'bootstrap', cause },
      },
      { writer: ctx.writer, exit: ctx.exit },
    );
    return;
  }

  if (result.funding) {
    emitEnvelope(
      {
        code: 'funding_required',
        message: result.message,
        hint: 'Fund the listed address and re-run jinn bootstrap.',
        exampleCli: 'jinn fund-requirements --json',
        details: {
          masterAddress: result.funding.master_address,
          asset: 'native',
          needWei: result.funding.eth_required,
          haveWei: result.funding.eth_balance,
        },
      },
      { writer: ctx.writer, exit: ctx.exit },
    );
    return;
  }

  if (!result.ok) {
    emitEnvelope(
      {
        code: 'fatal',
        message: result.message,
        hint: 'Bootstrap failed before the fleet reached a runnable state.',
        details: { stage: 'bootstrap' },
      },
      { writer: ctx.writer, exit: ctx.exit },
    );
    return;
  }

  // Success — emit a minimal JSON result and exit 0.
  const state = result.fleet_state;
  ctx.writer.write(JSON.stringify({
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    master: state.master_address,
    services: state.services.map((s) => ({
      index: s.index,
      step: s.step,
      serviceId: s.service_id ?? null,
    })),
  }) + '\n');
}

const command: CommandModule = {
  name: 'bootstrap',
  summary: 'Advance the fleet state machine toward a running daemon',
  helpText: `Usage: JINN_PASSWORD=... jinn bootstrap [--json]

Idempotent. Walks the fleet state machine from wherever it is toward
a complete, running state. Re-run as many times as needed; the
machine picks up where it left off. On funding gates, exits 10 with
a funding_required envelope.

Requires JINN_PASSWORD in the environment (never as a flag).

Examples:
  JINN_PASSWORD=secret jinn bootstrap
  JINN_PASSWORD=secret jinn bootstrap --json

Failure example (funding gate):
  $ JINN_PASSWORD=secret jinn bootstrap
  {"schemaVersion":1,"code":"funding_required","exitCode":10,...}
  $ echo $?
  10
`,
  run,
};

export default command;
```

- [ ] **Step 4: Register bootstrap in the dispatcher**

In `client/src/cli/index.ts`, add the import and push into COMMANDS:

```typescript
import bootstrapCommand from './commands/bootstrap.js';
```

And:

```typescript
const COMMANDS: CommandModule[] = [
  versionCommand,
  doctorCommand,
  bootstrapCommand,
];
```

- [ ] **Step 5: Run tests to verify pass**

Run:
```bash
cd client && npx vitest run test/cli/commands/bootstrap.test.ts
```

Expected: PASS (2 tests).

- [ ] **Step 6: Commit**

```bash
git add client/src/cli/commands/bootstrap.ts client/test/cli/commands/bootstrap.test.ts client/src/cli/index.ts
git commit -m "client(cli): add bootstrap verb with funding-required envelope"
```

---

## Task 9: `fund-requirements` verb

**Files:**
- Create: `client/src/cli/commands/fund-requirements.ts`
- Create: `client/test/cli/commands/fund-requirements.test.ts`
- Modify: `client/src/cli/index.ts` (register)

- [ ] **Step 1: Write the failing test**

Create `client/test/cli/commands/fund-requirements.test.ts`:

```typescript
import { describe, expect, it, vi } from 'vitest';
import type { CommandContext } from '../../../src/cli/command.js';

vi.mock('../../../src/earning/bootstrap.js', () => ({
  FleetBootstrapper: class {
    async bootstrap() {
      return {
        ok: false,
        funding: { master_address: '0xMASTER', eth_required: '1000000000000000000', eth_balance: '0' },
        message: 'need eth',
        fleet_state: { master_address: '0xMASTER', services: [] },
      };
    }
  },
}));

function makeCtx(env: Record<string, string> = { JINN_PASSWORD: 'test' }): {
  ctx: CommandContext; writes: string[];
} {
  const writes: string[] = [];
  const ctx: CommandContext = {
    argv: [],
    stdoutIsTty: false,
    writer: { write: (s: string) => { writes.push(s); return true; } },
    exit: () => { /* unused */ },
    env,
  };
  return { ctx, writes };
}

describe('fund-requirements command', () => {
  it('emits a requirements array with role, address, asset, needWei', async () => {
    const { default: fr } = await import('../../../src/cli/commands/fund-requirements.js');
    const { ctx, writes } = makeCtx();
    await fr.run(ctx);
    const parsed = JSON.parse(writes[writes.length - 1]);
    expect(parsed.schemaVersion).toBe(1);
    expect(Array.isArray(parsed.requirements)).toBe(true);
    expect(parsed.requirements[0]).toMatchObject({
      role: 'master',
      address: '0xMASTER',
      asset: 'native',
      needWei: '1000000000000000000',
      haveWei: '0',
    });
    expect(parsed.satisfied).toBe(false);
  });

  it('reports satisfied=true with empty requirements when no funding needed', async () => {
    vi.resetModules();
    vi.doMock('../../../src/earning/bootstrap.js', () => ({
      FleetBootstrapper: class {
        async bootstrap() {
          return { ok: true, fleet_state: { master_address: '0xM', services: [] } };
        }
      },
    }));
    const { default: fr } = await import('../../../src/cli/commands/fund-requirements.js');
    const { ctx, writes } = makeCtx();
    await fr.run(ctx);
    const parsed = JSON.parse(writes[writes.length - 1]);
    expect(parsed.satisfied).toBe(true);
    expect(parsed.requirements).toEqual([]);
    vi.doUnmock('../../../src/earning/bootstrap.js');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:
```bash
cd client && npx vitest run test/cli/commands/fund-requirements.test.ts
```

Expected: FAIL with "Cannot find module".

- [ ] **Step 3: Implement the fund-requirements command**

Create `client/src/cli/commands/fund-requirements.ts`:

```typescript
import type { CommandContext, CommandModule } from '../command.js';
import { emitEnvelope } from '../../errors/envelope.js';
import { loadConfig } from '../../config.js';
import { FleetBootstrapper } from '../../earning/bootstrap.js';

interface FundingRequirement {
  role: string;
  address: string;
  asset: 'native' | 'bond' | 'reward';
  haveWei: string;
  needWei: string;
  reason: string;
  blocks: string;
  details: { tokenAddress: string | null; tokenSymbol: string };
}

async function run(ctx: CommandContext): Promise<void> {
  const password = ctx.env['JINN_PASSWORD'];
  if (!password) {
    emitEnvelope(
      {
        code: 'invalid_invocation',
        message: 'JINN_PASSWORD is required to read the keystore.',
        exampleCli: 'JINN_PASSWORD=... jinn fund-requirements',
        details: { field: 'JINN_PASSWORD', expected: 'non-empty string' },
      },
      { writer: ctx.writer, exit: ctx.exit },
    );
    return;
  }

  const config = loadConfig();
  const bootstrapper = new FleetBootstrapper({
    earningDir: config.earningDir,
    chain: config.network === 'testnet' ? 'base-sepolia' : 'base',
    rpcUrl: config.rpcUrl,
    stakingMode: config.stakingMode,
    targetServices: config.targetServices,
    testnetL2DeploymentPath: config.testnetL2DeploymentPath,
    testnetL2TokenDeploymentPath: config.testnetL2TokenDeploymentPath,
    testnetMechDeploymentPath: config.testnetMechDeploymentPath,
    testnetStolasDeploymentPath: config.testnetStolasDeploymentPath,
  });

  const result = await bootstrapper.bootstrap(password);

  const requirements: FundingRequirement[] = [];
  if (result.funding) {
    requirements.push({
      role: 'master',
      address: result.funding.master_address,
      asset: 'native',
      haveWei: result.funding.eth_balance,
      needWei: result.funding.eth_required,
      reason: result.message,
      blocks: 'bootstrap',
      details: { tokenAddress: null, tokenSymbol: 'ETH' },
    });
  }

  const payload = {
    schemaVersion: 1 as const,
    generatedAt: new Date().toISOString(),
    requirements,
    satisfied: requirements.length === 0,
  };
  ctx.writer.write(JSON.stringify(payload) + '\n');
}

const command: CommandModule = {
  name: 'fund-requirements',
  summary: 'List addresses that need funding before the next bootstrap step',
  helpText: `Usage: JINN_PASSWORD=... jinn fund-requirements [--json]

Returns a JSON object listing every wallet that needs additional
funding before the state machine can advance. Each entry names the
wallet role (never the internal address alone), the asset role
(native / bond / reward), the amount needed, and a token symbol
lookup for operators that need to bridge or faucet.

When \`satisfied\` is true, the \`requirements\` array is empty and
no funding is needed right now.

Examples:
  JINN_PASSWORD=secret jinn fund-requirements
  JINN_PASSWORD=secret jinn fund-requirements --json | jq '.requirements[]'
`,
  run,
};

export default command;
```

- [ ] **Step 4: Register fund-requirements in the dispatcher**

In `client/src/cli/index.ts`:

```typescript
import fundRequirementsCommand from './commands/fund-requirements.js';
```

```typescript
const COMMANDS: CommandModule[] = [
  versionCommand,
  doctorCommand,
  bootstrapCommand,
  fundRequirementsCommand,
];
```

- [ ] **Step 5: Run tests to verify pass**

Run:
```bash
cd client && npx vitest run test/cli/commands/fund-requirements.test.ts
```

Expected: PASS (2 tests).

- [ ] **Step 6: Commit**

```bash
git add client/src/cli/commands/fund-requirements.ts client/test/cli/commands/fund-requirements.test.ts client/src/cli/index.ts
git commit -m "client(cli): add fund-requirements verb"
```

---

## Task 10: `init` verb — wallet generation only

**Files:**
- Create: `client/src/cli/commands/init.ts`
- Create: `client/test/cli/commands/init.test.ts`
- Modify: `client/src/cli/index.ts` (register)

`init` is a narrower subset of `bootstrap`: it only generates the master wallet and writes the keystore. It stops before any RPC call. Useful for CI pre-seeding and for agents that want to generate the wallet, fund it, then run `bootstrap`.

- [ ] **Step 1: Write the failing test**

Create `client/test/cli/commands/init.test.ts`:

```typescript
import { describe, expect, it } from 'vitest';
import { mkdtempSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import init from '../../../src/cli/commands/init.js';
import type { CommandContext } from '../../../src/cli/command.js';

function makeCtx(overrides: Partial<CommandContext> = {}): {
  ctx: CommandContext; writes: string[];
} {
  const writes: string[] = [];
  const earningDir = mkdtempSync(join(tmpdir(), 'jinn-init-test-'));
  const ctx: CommandContext = {
    argv: [],
    stdoutIsTty: false,
    writer: { write: (s: string) => { writes.push(s); return true; } },
    exit: () => { /* unused */ },
    env: { JINN_PASSWORD: 'testpw', JINN_EARNING_DIR: earningDir },
    ...overrides,
  };
  return { ctx, writes };
}

describe('init command', () => {
  it('creates a keystore and emits the master address', async () => {
    const { ctx, writes } = makeCtx();
    await init.run(ctx);
    const parsed = JSON.parse(writes[writes.length - 1]);
    expect(parsed.schemaVersion).toBe(1);
    expect(parsed.master).toMatch(/^0x[0-9a-fA-F]{40}$/);
    expect(existsSync(join(ctx.env['JINN_EARNING_DIR']!, 'mnemonic.keystore.json'))).toBe(true);
  });

  it('is idempotent — second run returns the same master address', async () => {
    const { ctx: ctx1, writes: w1 } = makeCtx();
    await init.run(ctx1);
    const first = JSON.parse(w1[w1.length - 1]).master;

    // Reuse the same earning dir
    const { ctx: ctx2 } = makeCtx({ env: ctx1.env });
    const writes2: string[] = [];
    ctx2.writer.write = (s: string) => { writes2.push(s); return true; };
    await init.run(ctx2);
    const second = JSON.parse(writes2[writes2.length - 1]).master;
    expect(second).toBe(first);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:
```bash
cd client && npx vitest run test/cli/commands/init.test.ts
```

Expected: FAIL with "Cannot find module".

- [ ] **Step 3: Implement the init command**

Create `client/src/cli/commands/init.ts`:

```typescript
import { existsSync } from 'node:fs';
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
  const keystorePath = join(earningDir, 'mnemonic.keystore.json');

  let masterAddress: string;
  if (existsSync(keystorePath)) {
    const mnemonic = await decryptMnemonic(await store.loadMnemonicKeystore(), password);
    masterAddress = deriveMasterAddress(mnemonic);
  } else {
    const mnemonic = generateMnemonic();
    const keystore = await encryptMnemonic(mnemonic, password);
    await store.saveMnemonicKeystore(keystore);
    masterAddress = deriveMasterAddress(mnemonic);
  }

  ctx.writer.write(JSON.stringify({
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    master: masterAddress,
    keystoreDir: earningDir,
  }) + '\n');
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
```

- [ ] **Step 4: Register init in the dispatcher**

In `client/src/cli/index.ts`, add and include in COMMANDS:

```typescript
import initCommand from './commands/init.js';
```

```typescript
const COMMANDS: CommandModule[] = [
  versionCommand,
  doctorCommand,
  initCommand,
  bootstrapCommand,
  fundRequirementsCommand,
];
```

- [ ] **Step 5: Run tests to verify pass**

Run:
```bash
cd client && npx vitest run test/cli/commands/init.test.ts
```

Expected: PASS (2 tests).

- [ ] **Step 6: Commit**

```bash
git add client/src/cli/commands/init.ts client/test/cli/commands/init.test.ts client/src/cli/index.ts
git commit -m "client(cli): add init verb for standalone wallet generation"
```

---

## Task 11: `run` verb — long-running daemon

**Files:**
- Create: `client/src/cli/commands/run.ts`
- Create: `client/test/cli/commands/run.test.ts`
- Modify: `client/src/cli/index.ts` (register)

The `run` verb is a thin wrapper over the existing `main()` logic in
`client/src/main.ts`. To keep the diff tight and avoid duplicating
the 200-line main function, we'll export `main` from `main.ts` and
call it from the `run` command. The existing `client/src/main.ts`
top-level invocation stays in place for npm-start compatibility.

- [ ] **Step 1: Export main from main.ts**

In `client/src/main.ts`, find:

```typescript
async function main(): Promise<void> {
```

Change to:

```typescript
export async function main(): Promise<void> {
```

No other changes — the bottom-level `main().catch(...)` invocation stays so `npx jinn run` still works.

- [ ] **Step 2: Write the failing test**

Create `client/test/cli/commands/run.test.ts`:

```typescript
import { describe, expect, it, vi } from 'vitest';
import type { CommandContext } from '../../../src/cli/command.js';

vi.mock('../../../src/main.js', () => ({
  main: vi.fn(async () => { /* successful daemon start */ }),
}));

function makeCtx(env: Record<string, string> = { JINN_PASSWORD: 'test' }): {
  ctx: CommandContext; writes: string[]; exits: number[];
} {
  const writes: string[] = [];
  const exits: number[] = [];
  const ctx: CommandContext = {
    argv: [],
    stdoutIsTty: false,
    writer: { write: (s: string) => { writes.push(s); return true; } },
    exit: (code: number) => { exits.push(code); },
    env,
  };
  return { ctx, writes, exits };
}

describe('run command', () => {
  it('requires JINN_PASSWORD', async () => {
    const { default: run } = await import('../../../src/cli/commands/run.js');
    const { ctx, writes, exits } = makeCtx({});
    await run.run(ctx);
    const parsed = JSON.parse(writes[writes.length - 1]);
    expect(parsed.code).toBe('invalid_invocation');
    expect(exits).toEqual([11]);
  });

  it('delegates to main() when JINN_PASSWORD is set', async () => {
    const { default: run } = await import('../../../src/cli/commands/run.js');
    const { main } = await import('../../../src/main.js');
    const { ctx } = makeCtx();
    await run.run(ctx);
    expect(main).toHaveBeenCalled();
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run:
```bash
cd client && npx vitest run test/cli/commands/run.test.ts
```

Expected: FAIL with "Cannot find module '../../../src/cli/commands/run.js'".

- [ ] **Step 4: Implement the run command**

Create `client/src/cli/commands/run.ts`:

```typescript
import type { CommandContext, CommandModule } from '../command.js';
import { emitEnvelope } from '../../errors/envelope.js';
import { main } from '../../main.js';

async function run(ctx: CommandContext): Promise<void> {
  if (!ctx.env['JINN_PASSWORD']) {
    emitEnvelope(
      {
        code: 'invalid_invocation',
        message: 'JINN_PASSWORD is required to start the daemon.',
        exampleCli: 'JINN_PASSWORD=... jinn run',
        details: { field: 'JINN_PASSWORD', expected: 'non-empty string' },
      },
      { writer: ctx.writer, exit: ctx.exit },
    );
    return;
  }
  // Delegate to the existing main.ts entry; it owns signal handlers and
  // daemon lifecycle. Errors are already routed through emitEnvelope by
  // main.ts's catch handler (plan 01).
  await main();
}

const command: CommandModule = {
  name: 'run',
  summary: 'Start the daemon in the foreground; stops on SIGINT/SIGTERM',
  helpText: `Usage: JINN_PASSWORD=... jinn run [--json]

Long-running. Starts the creator, restorer, and delivery-watcher
loops and runs until the process receives SIGINT or SIGTERM. Before
starting, advances the fleet state machine if needed; exits 10 with
a funding_required envelope if funding is missing.

Examples:
  JINN_PASSWORD=secret jinn run
  JINN_PASSWORD=secret jinn run --json 2>/tmp/jinn.log
`,
  run,
};

export default command;
```

- [ ] **Step 5: Register run in the dispatcher**

In `client/src/cli/index.ts`:

```typescript
import runCommand from './commands/run.js';
```

```typescript
const COMMANDS: CommandModule[] = [
  versionCommand,
  doctorCommand,
  initCommand,
  bootstrapCommand,
  fundRequirementsCommand,
  runCommand,
];
```

- [ ] **Step 6: Run tests to verify pass**

Run:
```bash
cd client && npx vitest run test/cli/commands/run.test.ts
```

Expected: PASS (2 tests).

- [ ] **Step 7: Commit**

```bash
git add client/src/main.ts client/src/cli/commands/run.ts client/test/cli/commands/run.test.ts client/src/cli/index.ts
git commit -m "client(cli): add run verb delegating to main()"
```

---

## Task 12: `stop` verb — signal the running daemon

**Files:**
- Create: `client/src/cli/commands/stop.ts`
- Create: `client/test/cli/commands/stop.test.ts`
- Modify: `client/src/main.ts` (write pidfile on start)
- Modify: `client/src/cli/index.ts` (register)

`stop` sends `SIGTERM` to the PID recorded in `~/.jinn-client/daemon.pid`. `main()` writes this pidfile on startup and removes it on shutdown. Agents can send `SIGTERM` themselves if they tracked the PID; `stop` is the ergonomic wrapper.

- [ ] **Step 1: Add pidfile write to main.ts**

In `client/src/main.ts`, find the `main` function body near where `await daemon.start();` appears, immediately before that line. Add:

```typescript
  // Write pidfile so `jinn stop` can find us.
  const pidPath = join(config.earningDir, 'daemon.pid');
  const { writeFileSync, unlinkSync } = await import('node:fs');
  writeFileSync(pidPath, String(process.pid) + '\n', 'utf-8');
  const removePidfile = () => { try { unlinkSync(pidPath); } catch { /* ignore */ } };
  process.on('exit', removePidfile);
```

Ensure `join` is already imported at the top of `main.ts` (it is, from `node:path`).

- [ ] **Step 2: Write the failing test**

Create `client/test/cli/commands/stop.test.ts`:

```typescript
import { describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import stop from '../../../src/cli/commands/stop.js';
import type { CommandContext } from '../../../src/cli/command.js';

function makeCtx(env: Record<string, string> = {}): {
  ctx: CommandContext; writes: string[]; exits: number[];
} {
  const writes: string[] = [];
  const exits: number[] = [];
  const ctx: CommandContext = {
    argv: [],
    stdoutIsTty: false,
    writer: { write: (s: string) => { writes.push(s); return true; } },
    exit: (code: number) => { exits.push(code); },
    env,
  };
  return { ctx, writes, exits };
}

describe('stop command', () => {
  it('emits invalid_invocation when no pidfile exists', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'jinn-stop-test-'));
    const { ctx, writes, exits } = makeCtx({ JINN_EARNING_DIR: dir });
    await stop.run(ctx);
    const parsed = JSON.parse(writes[writes.length - 1]);
    expect(parsed.code).toBe('invalid_invocation');
    expect(parsed.details?.field).toBe('daemon_pidfile');
    expect(exits).toEqual([11]);
  });

  it('reads the pidfile and reports the pid on success', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'jinn-stop-test-'));
    writeFileSync(join(dir, 'daemon.pid'), '99999\n');
    const { ctx, writes } = makeCtx({ JINN_EARNING_DIR: dir });
    // PID 99999 almost certainly doesn't exist — stop should still emit a
    // success-shaped response with killed=false rather than an envelope.
    await stop.run(ctx);
    const parsed = JSON.parse(writes[writes.length - 1]);
    expect(parsed.schemaVersion).toBe(1);
    expect(parsed.pid).toBe(99999);
    expect(typeof parsed.killed).toBe('boolean');
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run:
```bash
cd client && npx vitest run test/cli/commands/stop.test.ts
```

Expected: FAIL with "Cannot find module".

- [ ] **Step 4: Implement the stop command**

Create `client/src/cli/commands/stop.ts`:

```typescript
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { CommandContext, CommandModule } from '../command.js';
import { emitEnvelope } from '../../errors/envelope.js';

async function run(ctx: CommandContext): Promise<void> {
  const earningDir = ctx.env['JINN_EARNING_DIR'] ?? join(process.env['HOME'] ?? '.', '.jinn-client', 'earning');
  const pidPath = join(earningDir, 'daemon.pid');

  if (!existsSync(pidPath)) {
    emitEnvelope(
      {
        code: 'invalid_invocation',
        message: 'No running daemon pidfile found.',
        hint: 'The daemon writes its pid to <earningDir>/daemon.pid on startup. Start it with `jinn run` first.',
        exampleCli: 'jinn run',
        details: { field: 'daemon_pidfile', expected: pidPath },
      },
      { writer: ctx.writer, exit: ctx.exit },
    );
    return;
  }

  const pid = parseInt(readFileSync(pidPath, 'utf-8').trim(), 10);
  let killed = false;
  try {
    process.kill(pid, 'SIGTERM');
    killed = true;
  } catch {
    // Process already gone; treat as success with killed=false.
  }

  ctx.writer.write(JSON.stringify({
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    pid,
    killed,
  }) + '\n');
}

const command: CommandModule = {
  name: 'stop',
  summary: 'Signal a running jinn daemon to shut down gracefully',
  helpText: `Usage: jinn stop [--json]

Reads the daemon pid from <earningDir>/daemon.pid and sends SIGTERM.
Idempotent: if the daemon is already stopped, returns killed=false
with exit 0.

Examples:
  jinn stop
  jinn stop --json | jq '.killed'
`,
  run,
};

export default command;
```

- [ ] **Step 5: Register stop in the dispatcher**

In `client/src/cli/index.ts`:

```typescript
import stopCommand from './commands/stop.js';
```

```typescript
const COMMANDS: CommandModule[] = [
  versionCommand,
  doctorCommand,
  initCommand,
  bootstrapCommand,
  fundRequirementsCommand,
  runCommand,
  stopCommand,
];
```

- [ ] **Step 6: Run tests to verify pass**

Run:
```bash
cd client && npx vitest run test/cli/commands/stop.test.ts
```

Expected: PASS (2 tests).

- [ ] **Step 7: Commit**

```bash
git add client/src/main.ts client/src/cli/commands/stop.ts client/test/cli/commands/stop.test.ts client/src/cli/index.ts
git commit -m "client(cli): add stop verb and daemon pidfile"
```

---

## Task 13: Final verification

- [ ] **Step 1: Full typecheck**

Run:
```bash
cd client && npx tsc --noEmit
```

Expected: zero errors.

- [ ] **Step 2: Full test suite**

Run:
```bash
cd client && npx vitest run
```

Expected: all tests pass. Count should be previous total + new CLI tests (output ≈ 6, help ≈ 2, index ≈ 4, version ≈ 2, doctor ≈ 2, bootstrap ≈ 2, fund-requirements ≈ 2, init ≈ 2, run ≈ 2, stop ≈ 2) = ~26 new tests.

- [ ] **Step 3: Manual smoke — top-level help**

Run:
```bash
cd client && ./bin/jinn --help
```

Expected: lists `version`, `doctor`, `init`, `bootstrap`, `fund-requirements`, `run`, `stop` with summaries.

- [ ] **Step 4: Manual smoke — version verb**

Run:
```bash
cd client && ./bin/jinn version --json
```

Expected: a JSON object on stdout with `schemaVersion: 1`, `client.version`, `protocol.specVersion: 1`, `network`, `tokens`.

- [ ] **Step 5: Manual smoke — doctor verb**

Run:
```bash
cd client && ./bin/jinn doctor --json | jq '.ok, .blockingCount'
```

Expected: a boolean followed by a number. The exact ok/blockingCount depends on the local environment.

- [ ] **Step 6: Manual smoke — unknown verb**

Run:
```bash
cd client && ./bin/jinn no-such-verb; echo "exit=$?"
```

Expected: a JSON envelope with `"code":"invalid_invocation"` and `exit=11`.

---

## Spec coverage

| Spec section | Covered by |
|---|---|
| §2.1 Lifecycle verbs (init, doctor, bootstrap, fund-requirements, run, stop, version) | Tasks 5–12 |
| §4.5 doctor shape | Task 7 |
| §4.6 fund-requirements shape | Task 9 |
| §4.7 version shape | Task 5 |
| §6 Error envelope wiring | Tasks 6–12 (every verb uses emitEnvelope) |
| §7.2 JSON-by-default on non-TTY | Task 2 output helpers |
| §7.1 Headless-first (no prompts) | All tasks; every command reads env, never stdin |

Not covered (intentional, deferred to later plans):
- §2.2 introspection verbs — plan 03
- §2.3 action verbs — plan 04
- §7.3 dry-run / yes — plan 04
- Deployment digest in `jinn version` — deferred; currently emits `"digest": "unknown"`
