# et6s — `jinn create plugin` scaffold implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extend `jinn create` with a `plugin` target that scaffolds working SolverPlugin packages in two patterns (`solver-type-plugin`, `runtime-plugin`), with first-run `yarn test` passing on the generated package.

**Architecture:** Mirror the existing `jinn create harness` pattern in `client/src/cli/commands/create.ts`. Add a `target: 'plugin'` branch with two `pattern` values. Templates live at `client/templates/plugins/<pattern>/` and follow the existing `{{variable}}` substitution scheme. The scaffolded test asserts the package's `jinn.plugin.json` loads cleanly via `loadSolverPluginManifest`.

**Tech Stack:** Vitest, TypeScript, Node.js. No new dependencies. Reuses `client/src/plugins/manifest.ts` `loadSolverPluginManifest` for the scaffolded test.

---

## File structure

**Modify:**
- `client/src/cli/commands/create.ts` — add `target: 'plugin'` branch; add `PluginPattern` type + `SUPPORTED_PLUGIN_PATTERNS` array + `SOLVER_TYPE_PLUGIN_FILES` + `RUNTIME_PLUGIN_FILES` template manifests; extend `runCreate` to dispatch on target; extend the CLI handler with the new subcommand + flags; extend HELP_TEXT.

**Create — `solver-type-plugin` template:**
- `client/templates/plugins/solver-type-plugin/package.json.tmpl`
- `client/templates/plugins/solver-type-plugin/jinn.plugin.json.tmpl`
- `client/templates/plugins/solver-type-plugin/skills/example/SKILL.md.tmpl`
- `client/templates/plugins/solver-type-plugin/test/plugin.test.ts.tmpl`
- `client/templates/plugins/solver-type-plugin/README.md.tmpl`
- `client/templates/plugins/solver-type-plugin/gitignore.tmpl`
- `client/templates/plugins/solver-type-plugin/tsconfig.json.tmpl`

**Create — `runtime-plugin` template:**
- `client/templates/plugins/runtime-plugin/package.json.tmpl`
- `client/templates/plugins/runtime-plugin/jinn.plugin.json.tmpl`
- `client/templates/plugins/runtime-plugin/.mcp.json.tmpl`
- `client/templates/plugins/runtime-plugin/mcp/server.mjs.tmpl`
- `client/templates/plugins/runtime-plugin/test/plugin.test.ts.tmpl`
- `client/templates/plugins/runtime-plugin/README.md.tmpl`
- `client/templates/plugins/runtime-plugin/gitignore.tmpl`
- `client/templates/plugins/runtime-plugin/tsconfig.json.tmpl`

**Modify (tests):**
- `client/test/cli/commands/create.test.ts` — add `runCreate (plugin target — solver-type-plugin)` describe + `runCreate (plugin target — runtime-plugin)` describe + an end-to-end test that runs `yarn install && yarn test` in a scaffolded package and asserts pass.

The scaffolded test inside the templates depends only on `vitest` and one local relative import to `client/src/plugins` — wired via a `workspace:*` style local link OR via a published `@jinn-network/client` runtime. **For v0, the scaffolded `package.json.tmpl` depends on `vitest` only**; the scaffolded test calls a minimal JSON-shape assertion against `jinn.plugin.json` without importing from the client. This keeps the scaffold standalone (no monorepo wiring required at first run).

---

## Task 1: Add the solver-type-plugin template files

**Files to create:** `client/templates/plugins/solver-type-plugin/*` (7 files)

- [ ] **Step 1: Create the template directory structure**

```bash
mkdir -p client/templates/plugins/solver-type-plugin/skills/example
mkdir -p client/templates/plugins/solver-type-plugin/test
```

- [ ] **Step 2: Write `package.json.tmpl`**

Create `client/templates/plugins/solver-type-plugin/package.json.tmpl`:

```json
{
  "name": "{{packageName}}",
  "version": "0.1.0",
  "description": "Jinn SolverPlugin for {{solverTypeString}}.",
  "type": "module",
  "files": ["jinn.plugin.json", "skills/", "README.md"],
  "scripts": {
    "test": "vitest run"
  },
  "devDependencies": {
    "vitest": "^2.0.0"
  },
  "keywords": ["jinn", "solver-plugin", "{{solverTypeString}}"],
  "license": "MIT"
}
```

- [ ] **Step 3: Write `jinn.plugin.json.tmpl`**

Create `client/templates/plugins/solver-type-plugin/jinn.plugin.json.tmpl`:

```json
{
  "name": "{{packageName}}",
  "version": "0.1.0",
  "jinn": {
    "supports": ["{{solverTypeString}}"],
    "skills": [
      "skills/example/SKILL.md"
    ],
    "description": "Example SolverPlugin for {{solverTypeString}}."
  }
}
```

- [ ] **Step 4: Write `skills/example/SKILL.md.tmpl`**

Create `client/templates/plugins/solver-type-plugin/skills/example/SKILL.md.tmpl`:

```markdown
---
name: {{packageNameSlug}}-example
description: An example skill that ships with the {{packageName}} plug-in. Replace this body with your plug-in's actual skill content.
---

# Example skill

This skill is a placeholder. Replace its body with content that helps a solver agent attempt `{{solverTypeString}}` tasks.

Skills are markdown files with YAML frontmatter. The frontmatter's `name` and `description` are used by harnesses to decide when to load the skill into context.
```

- [ ] **Step 5: Write `test/plugin.test.ts.tmpl`**

Create `client/templates/plugins/solver-type-plugin/test/plugin.test.ts.tmpl`:

```typescript
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

describe('{{packageName}} manifest', () => {
  it('has a valid jinn.plugin.json', () => {
    const manifestPath = join(ROOT, 'jinn.plugin.json');
    expect(existsSync(manifestPath)).toBe(true);
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    expect(manifest.name).toBe('{{packageName}}');
    expect(manifest.jinn.supports).toContain('{{solverTypeString}}');
    expect(Array.isArray(manifest.jinn.skills)).toBe(true);
  });

  it('every declared skill file exists', () => {
    const manifestPath = join(ROOT, 'jinn.plugin.json');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    for (const skill of manifest.jinn.skills ?? []) {
      expect(existsSync(join(ROOT, skill)), `missing skill file: ${skill}`).toBe(true);
    }
  });
});
```

- [ ] **Step 6: Write `README.md.tmpl`**

Create `client/templates/plugins/solver-type-plugin/README.md.tmpl`:

```markdown
# {{packageName}}

Jinn SolverPlugin targeting `{{solverTypeString}}`.

## What this is

A SolverPlugin is a package that drops into a Jinn-running harness (Hermes, Claude Code, Codex) and contributes skills + MCP tools when the harness runs a task on `{{solverTypeString}}`. See the canonical `/docs/build/` tree for the full builder reference.

## Get started

```bash
yarn install
yarn test
```

Edit `skills/example/SKILL.md` with the actual skill content you want to ship. Add new skill files under `skills/<name>/SKILL.md` and add their paths to `jinn.plugin.json`'s `jinn.skills` array.

## Publish

When ready to ship:

```bash
# Validate the manifest first
jinn solver-plugins validate path:.

# Publish to the Jinn network
jinn solver-plugins publish path:.
```

The published plug-in becomes discoverable to operators running `{{solverTypeString}}` SolverNets.

## Reference

- Quickstart: https://github.com/Jinn-Network/mono/blob/main/cargo/docs/build/quickstart.md (placeholder until `52x3.6` ships the canonical docs tree)
- Spec: `docs/superpowers/specs/2026-05-13-plug-in-builder-entry-point-design.md`
```

- [ ] **Step 7: Write `gitignore.tmpl`**

Create `client/templates/plugins/solver-type-plugin/gitignore.tmpl`:

```
node_modules/
.DS_Store
*.log
```

- [ ] **Step 8: Write `tsconfig.json.tmpl`** (kept for parity with harness templates; not strictly needed since the scaffolded code is markdown + JSON, but provides headroom for builders who add TS later)

Create `client/templates/plugins/solver-type-plugin/tsconfig.json.tmpl`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "esModuleInterop": true,
    "strict": true,
    "skipLibCheck": true
  },
  "include": ["test/**/*.ts"]
}
```

- [ ] **Step 9: Commit template files**

```bash
git add client/templates/plugins/solver-type-plugin/
git commit -m "feat(et6s): solver-type-plugin scaffold template files"
```

---

## Task 2: Add the runtime-plugin template files

**Files to create:** `client/templates/plugins/runtime-plugin/*` (8 files)

- [ ] **Step 1: Create the template directory structure**

```bash
mkdir -p client/templates/plugins/runtime-plugin/mcp
mkdir -p client/templates/plugins/runtime-plugin/test
```

- [ ] **Step 2: Write `package.json.tmpl`**

Create `client/templates/plugins/runtime-plugin/package.json.tmpl`:

```json
{
  "name": "{{packageName}}",
  "version": "0.1.0",
  "description": "Jinn runtime SolverPlugin — exposes MCP tools available to every harness session.",
  "type": "module",
  "files": ["jinn.plugin.json", ".mcp.json", "mcp/", "README.md"],
  "scripts": {
    "test": "vitest run"
  },
  "devDependencies": {
    "vitest": "^2.0.0"
  },
  "keywords": ["jinn", "solver-plugin", "runtime", "mcp"],
  "license": "MIT"
}
```

- [ ] **Step 3: Write `jinn.plugin.json.tmpl`**

Create `client/templates/plugins/runtime-plugin/jinn.plugin.json.tmpl`:

```json
{
  "name": "{{packageName}}",
  "version": "0.1.0",
  "jinn": {
    "supports": ["jinn.runtime"],
    "capabilities": {
      "tools": {
        "example": [
          "example_tool"
        ]
      }
    },
    "mcpServers": {
      "example": {
        "command": "node",
        "args": ["mcp/server.mjs"]
      }
    },
    "description": "Example runtime SolverPlugin exposing one MCP tool."
  }
}
```

- [ ] **Step 4: Write `.mcp.json.tmpl`**

Create `client/templates/plugins/runtime-plugin/.mcp.json.tmpl`:

```json
{
  "mcpServers": {
    "example": {
      "command": "node",
      "args": ["mcp/server.mjs"]
    }
  }
}
```

- [ ] **Step 5: Write `mcp/server.mjs.tmpl`**

Create `client/templates/plugins/runtime-plugin/mcp/server.mjs.tmpl`:

```javascript
#!/usr/bin/env node

// Minimal MCP server stub.
//
// Replace this body with a real MCP server implementation (e.g. via
// @modelcontextprotocol/sdk) that exposes the tools declared in
// jinn.plugin.json's jinn.mcpServers.example.

import { createInterface } from 'node:readline';

const rl = createInterface({ input: process.stdin });

rl.on('line', (line) => {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  if (msg?.method === 'initialize') {
    process.stdout.write(
      JSON.stringify({
        jsonrpc: '2.0',
        id: msg.id,
        result: {
          protocolVersion: '2024-11-05',
          capabilities: { tools: {} },
          serverInfo: { name: '{{packageNameSlug}}-example', version: '0.1.0' },
        },
      }) + '\n',
    );
  }
});
```

- [ ] **Step 6: Write `test/plugin.test.ts.tmpl`**

Create `client/templates/plugins/runtime-plugin/test/plugin.test.ts.tmpl`:

```typescript
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

describe('{{packageName}} runtime manifest', () => {
  it('has a valid jinn.plugin.json declaring jinn.runtime', () => {
    const manifest = JSON.parse(
      readFileSync(join(ROOT, 'jinn.plugin.json'), 'utf8'),
    );
    expect(manifest.name).toBe('{{packageName}}');
    expect(manifest.jinn.supports).toEqual(['jinn.runtime']);
  });

  it('has a .mcp.json mirroring the jinn.plugin.json mcpServers block', () => {
    expect(existsSync(join(ROOT, '.mcp.json'))).toBe(true);
    const mcp = JSON.parse(readFileSync(join(ROOT, '.mcp.json'), 'utf8'));
    expect(mcp.mcpServers).toBeDefined();
    expect(Object.keys(mcp.mcpServers).length).toBeGreaterThan(0);
  });

  it('every declared MCP server entry-point file exists', () => {
    const mcp = JSON.parse(readFileSync(join(ROOT, '.mcp.json'), 'utf8'));
    for (const [, server] of Object.entries(mcp.mcpServers as Record<string, { args?: string[] }>)) {
      const args = server.args ?? [];
      for (const arg of args) {
        if (arg.endsWith('.mjs') || arg.endsWith('.js') || arg.endsWith('.ts')) {
          expect(existsSync(join(ROOT, arg)), `missing MCP entry file: ${arg}`).toBe(true);
        }
      }
    }
  });
});
```

- [ ] **Step 7: Write `README.md.tmpl`**

Create `client/templates/plugins/runtime-plugin/README.md.tmpl`:

```markdown
# {{packageName}}

Jinn runtime SolverPlugin — exposes MCP tools to every Jinn harness session, regardless of SolverNet.

## What this is

A runtime SolverPlugin declares `jinn.supports: ['jinn.runtime']` and is loaded by Jinn-running daemons as a global MCP tool source. Use this pattern when your plug-in's value is harness-shaped (a network tool, a data lookup, a system probe) rather than task-shaped.

If your plug-in is task-shaped (skills + tools scoped to a specific SolverNet), use the `solver-type-plugin` pattern instead: `jinn create plugin <name> --pattern solver-type-plugin --solver-type <id>`.

## Get started

```bash
yarn install
yarn test
```

Replace `mcp/server.mjs` with a real MCP server implementation (typically via `@modelcontextprotocol/sdk`) exposing the tools you want available.

## Publish

```bash
jinn solver-plugins validate path:.
jinn solver-plugins publish path:.
```

## Reference

- Quickstart: https://github.com/Jinn-Network/mono/blob/main/cargo/docs/build/quickstart.md (placeholder until `52x3.6` ships the canonical docs tree)
- Existing reference: `client/plugins/network-tools/` in the Jinn monorepo.
```

- [ ] **Step 8: Write `gitignore.tmpl`**

Create `client/templates/plugins/runtime-plugin/gitignore.tmpl`:

```
node_modules/
.DS_Store
*.log
```

- [ ] **Step 9: Write `tsconfig.json.tmpl`**

Create `client/templates/plugins/runtime-plugin/tsconfig.json.tmpl`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "esModuleInterop": true,
    "strict": true,
    "skipLibCheck": true
  },
  "include": ["test/**/*.ts"]
}
```

- [ ] **Step 10: Commit template files**

```bash
git add client/templates/plugins/runtime-plugin/
git commit -m "feat(et6s): runtime-plugin scaffold template files"
```

---

## Task 3: Add the failing test for the `plugin` target (solver-type-plugin pattern)

**Files:**
- Modify: `client/test/cli/commands/create.test.ts`

- [ ] **Step 1: Add a new `describe` block for the solver-type-plugin pattern**

Add to the bottom of `client/test/cli/commands/create.test.ts`, before the final closing brace, after the existing `describe` blocks:

```typescript
describe('runCreate (plugin target — solver-type-plugin)', () => {
  it('emits a solver-type-plugin package matching the template', async () => {
    const target = await runCreate({
      target: 'plugin',
      pattern: 'solver-type-plugin',
      packageName: '@example/test-plugin',
      solverTypeString: 'swe-rebench-v2.v1',
      outDir: TMP,
    });
    expect(target).toBe(join(TMP, '@example/test-plugin'));
    expect(existsSync(join(target, 'package.json'))).toBe(true);
    expect(existsSync(join(target, 'jinn.plugin.json'))).toBe(true);
    expect(existsSync(join(target, 'skills/example/SKILL.md'))).toBe(true);
    expect(existsSync(join(target, 'test/plugin.test.ts'))).toBe(true);
    expect(existsSync(join(target, 'README.md'))).toBe(true);
    expect(existsSync(join(target, 'tsconfig.json'))).toBe(true);
    expect(existsSync(join(target, '.gitignore'))).toBe(true);

    const pkg = JSON.parse(readFileSync(join(target, 'package.json'), 'utf8'));
    expect(pkg.name).toBe('@example/test-plugin');
    expect(pkg.devDependencies.vitest).toBeDefined();

    const manifest = JSON.parse(
      readFileSync(join(target, 'jinn.plugin.json'), 'utf8'),
    );
    expect(manifest.name).toBe('@example/test-plugin');
    expect(manifest.jinn.supports).toContain('swe-rebench-v2.v1');
    expect(manifest.jinn.skills).toContain('skills/example/SKILL.md');

    const skillMd = readFileSync(join(target, 'skills/example/SKILL.md'), 'utf8');
    expect(skillMd).toContain('swe-rebench-v2.v1');
    expect(skillMd).not.toContain('{{');

    const testTs = readFileSync(join(target, 'test/plugin.test.ts'), 'utf8');
    expect(testTs).toContain('@example/test-plugin');
    expect(testTs).not.toContain('{{');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run from `client/`:
```bash
cd client && yarn vitest run test/cli/commands/create.test.ts --reporter=verbose 2>&1 | tail -20
```

Expected: FAIL with error indicating `runCreate` rejects target `'plugin'` (current code only supports `'harness'`).

- [ ] **Step 3: Commit the failing test**

```bash
git add client/test/cli/commands/create.test.ts
git commit -m "test(et6s): failing test for solver-type-plugin scaffold"
```

---

## Task 4: Extend `runCreate` to support `target: 'plugin'`

**Files:**
- Modify: `client/src/cli/commands/create.ts`

- [ ] **Step 1: Add the PluginPattern type and template manifests**

In `client/src/cli/commands/create.ts`, after the existing `HarnessPattern` and `SUPPORTED_PATTERNS` declarations (around line 50), add:

```typescript
export type PluginPattern = 'solver-type-plugin' | 'runtime-plugin';

export const SUPPORTED_PLUGIN_PATTERNS: readonly PluginPattern[] = [
  'solver-type-plugin',
  'runtime-plugin',
];

const SOLVER_TYPE_PLUGIN_FILES: TemplateFile[] = [
  { src: 'package.json.tmpl', dst: 'package.json' },
  { src: 'jinn.plugin.json.tmpl', dst: 'jinn.plugin.json' },
  { src: 'skills/example/SKILL.md.tmpl', dst: 'skills/example/SKILL.md' },
  { src: 'test/plugin.test.ts.tmpl', dst: 'test/plugin.test.ts' },
  { src: 'README.md.tmpl', dst: 'README.md' },
  { src: 'tsconfig.json.tmpl', dst: 'tsconfig.json' },
  { src: 'gitignore.tmpl', dst: '.gitignore' },
];

const RUNTIME_PLUGIN_FILES: TemplateFile[] = [
  { src: 'package.json.tmpl', dst: 'package.json' },
  { src: 'jinn.plugin.json.tmpl', dst: 'jinn.plugin.json' },
  { src: '.mcp.json.tmpl', dst: '.mcp.json' },
  { src: 'mcp/server.mjs.tmpl', dst: 'mcp/server.mjs' },
  { src: 'test/plugin.test.ts.tmpl', dst: 'test/plugin.test.ts' },
  { src: 'README.md.tmpl', dst: 'README.md' },
  { src: 'tsconfig.json.tmpl', dst: 'tsconfig.json' },
  { src: 'gitignore.tmpl', dst: '.gitignore' },
];

function pluginTemplateFiles(pattern: PluginPattern): TemplateFile[] {
  switch (pattern) {
    case 'solver-type-plugin':
      return SOLVER_TYPE_PLUGIN_FILES;
    case 'runtime-plugin':
      return RUNTIME_PLUGIN_FILES;
    default:
      throw new Error(`unsupported plugin pattern: ${pattern as string}`);
  }
}
```

- [ ] **Step 2: Update the `resolveTemplatesRoot` to also probe the `plugins/` subdir**

The existing function resolves the `harnesses/` templates dir. Refactor to take a target argument. Replace the existing function block (lines ~25-39) with:

```typescript
function resolveTemplatesRoot(target: 'harness' | 'plugin'): string {
  const subdir = target === 'harness' ? 'harnesses' : 'plugins';
  const here = fileURLToPath(new URL('.', import.meta.url));
  const candidates = [
    join(here, `../../../templates/${subdir}/`),
    join(here, `../../templates/${subdir}/`),
    join(here, `../../../../templates/${subdir}/`),
  ];
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  return candidates[0];
}
```

Remove the module-level `const TEMPLATES_ROOT = resolveTemplatesRoot();` line; replace usages inside `runCreate` with per-call lookup.

- [ ] **Step 3: Extend the `RunCreateArgs` type and `runCreate` function**

Replace the existing `RunCreateArgs` interface:

```typescript
export interface RunCreateArgs {
  target: 'harness' | 'plugin';
  pattern: HarnessPattern | PluginPattern;
  packageName: string;
  solverTypeString: string;
  network?: string;
  outDir: string;
}
```

Replace `runCreate` (lines ~134-161) with:

```typescript
export async function runCreate(args: RunCreateArgs): Promise<string> {
  const targetRoot = join(args.outDir, args.packageName);
  const vars: Record<string, string | number> = {
    packageName: args.packageName,
    packageNameSlug: packageNameSlug(args.packageName),
    solverTypeString: args.solverTypeString,
  };

  let files: TemplateFile[];
  let templatesRoot: string;

  if (args.target === 'harness') {
    const network = args.network ?? 'base-sepolia';
    const networkChainId = NETWORK_CHAIN_IDS[network];
    if (networkChainId === undefined) {
      throw new Error(
        `unknown network ${network}; known: ${Object.keys(NETWORK_CHAIN_IDS).join(', ')}`,
      );
    }
    vars.network = network;
    vars.networkChainId = networkChainId;
    files = templateFiles(args.pattern as HarnessPattern);
    templatesRoot = join(resolveTemplatesRoot('harness'), args.pattern);
  } else if (args.target === 'plugin') {
    files = pluginTemplateFiles(args.pattern as PluginPattern);
    templatesRoot = join(resolveTemplatesRoot('plugin'), args.pattern);
  } else {
    throw new Error(`unsupported target: ${(args as { target: string }).target}`);
  }

  for (const file of files) {
    const srcPath = join(templatesRoot, file.src);
    const dstPath = join(targetRoot, file.dst);
    const text = readFileSync(srcPath, 'utf8');
    mkdirSync(dirname(dstPath), { recursive: true });
    writeFileSync(dstPath, substitute(text, vars));
  }
  return targetRoot;
}
```

- [ ] **Step 4: Run the failing test — it should now pass**

```bash
cd client && yarn vitest run test/cli/commands/create.test.ts --reporter=verbose 2>&1 | tail -20
```

Expected: PASS for `runCreate (plugin target — solver-type-plugin)` block. Existing harness tests also still PASS.

- [ ] **Step 5: Commit**

```bash
git add client/src/cli/commands/create.ts
git commit -m "feat(et6s): runCreate supports target='plugin' with solver-type-plugin pattern"
```

---

## Task 5: Add the failing test for runtime-plugin pattern

**Files:**
- Modify: `client/test/cli/commands/create.test.ts`

- [ ] **Step 1: Add the test**

Append to `client/test/cli/commands/create.test.ts`:

```typescript
describe('runCreate (plugin target — runtime-plugin)', () => {
  it('emits a runtime-plugin package matching the template', async () => {
    const target = await runCreate({
      target: 'plugin',
      pattern: 'runtime-plugin',
      packageName: '@example/test-runtime',
      solverTypeString: 'jinn.runtime',
      outDir: TMP,
    });
    expect(target).toBe(join(TMP, '@example/test-runtime'));
    expect(existsSync(join(target, 'package.json'))).toBe(true);
    expect(existsSync(join(target, 'jinn.plugin.json'))).toBe(true);
    expect(existsSync(join(target, '.mcp.json'))).toBe(true);
    expect(existsSync(join(target, 'mcp/server.mjs'))).toBe(true);
    expect(existsSync(join(target, 'test/plugin.test.ts'))).toBe(true);

    const manifest = JSON.parse(
      readFileSync(join(target, 'jinn.plugin.json'), 'utf8'),
    );
    expect(manifest.jinn.supports).toEqual(['jinn.runtime']);

    const serverJs = readFileSync(join(target, 'mcp/server.mjs'), 'utf8');
    expect(serverJs).toContain('example-test-runtime-example');
    expect(serverJs).not.toContain('{{');
  });
});
```

- [ ] **Step 2: Run — should PASS already** (Task 4 implemented both patterns)

```bash
cd client && yarn vitest run test/cli/commands/create.test.ts --reporter=verbose 2>&1 | tail -20
```

Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add client/test/cli/commands/create.test.ts
git commit -m "test(et6s): runtime-plugin pattern coverage"
```

---

## Task 6: Add the failing scaffold-package-runs-yarn-test integration test

**Files:**
- Modify: `client/test/cli/commands/create.test.ts`

This test is the strongest acceptance signal — it confirms the scaffolded package's `yarn test` passes on first run.

- [ ] **Step 1: Add the test**

Append to `client/test/cli/commands/create.test.ts`:

```typescript
describe('runCreate (plugin target — first-run yarn test passes)', () => {
  it('scaffolded solver-type-plugin passes yarn install && yarn test', async () => {
    const target = await runCreate({
      target: 'plugin',
      pattern: 'solver-type-plugin',
      packageName: 'test-plugin-e2e',
      solverTypeString: 'swe-rebench-v2.v1',
      outDir: TMP,
    });
    // yarn install with --no-immutable so the missing lockfile doesn't fail
    const installResult = execFileSync('yarn', ['install', '--no-immutable'], {
      cwd: target,
      stdio: 'pipe',
      encoding: 'utf8',
    });
    expect(installResult).toBeDefined();
    const testResult = execFileSync('yarn', ['test'], {
      cwd: target,
      stdio: 'pipe',
      encoding: 'utf8',
    });
    expect(testResult).toMatch(/(passed|PASS)/i);
  }, 60_000);

  it('scaffolded runtime-plugin passes yarn install && yarn test', async () => {
    const target = await runCreate({
      target: 'plugin',
      pattern: 'runtime-plugin',
      packageName: 'test-runtime-e2e',
      solverTypeString: 'jinn.runtime',
      outDir: TMP,
    });
    execFileSync('yarn', ['install', '--no-immutable'], { cwd: target, stdio: 'pipe' });
    const testResult = execFileSync('yarn', ['test'], {
      cwd: target,
      stdio: 'pipe',
      encoding: 'utf8',
    });
    expect(testResult).toMatch(/(passed|PASS)/i);
  }, 60_000);
});
```

- [ ] **Step 2: Run — should PASS already** if Task 4 + the templates are correct.

```bash
cd client && yarn vitest run test/cli/commands/create.test.ts --reporter=verbose 2>&1 | tail -30
```

If either case fails, debug per the failure message and fix templates or `runCreate` as needed. Common issues:
- `vitest` not in `devDependencies` (already in template).
- Template still has `{{vars}}` unreplaced.
- `tsconfig.json` missing breaks Vitest's TS resolution → fix `tsconfig.json.tmpl`.

- [ ] **Step 3: Commit**

```bash
git add client/test/cli/commands/create.test.ts
git commit -m "test(et6s): scaffolded plug-in passes yarn install && yarn test on first run"
```

---

## Task 7: Extend the CLI surface — `jinn create plugin` subcommand

**Files:**
- Modify: `client/src/cli/commands/create.ts`

- [ ] **Step 1: Update HELP_TEXT**

Replace `HELP_TEXT` (around line 163) with:

```typescript
const HELP_TEXT = `\
jinn create harness <packageName>
jinn create plugin <packageName>

Scaffold a new Jinn package on disk.

Subcommands:
  harness    external Harness package (forecaster / evaluator / alternative-harness)
  plugin     SolverPlugin package (solver-type-plugin / runtime-plugin)

Harness options:
  --pattern=<pattern>     Template pattern (default: forecaster)
                          Supported: forecaster, evaluator, alternative-harness
  --solver-type=<value>   SolverType the Harness handles (default: prediction.v1)
  --network=<network>     Default network (default: base-sepolia)
                          One of: base-mainnet, base-sepolia, sepolia, ethereum-mainnet

Plugin options:
  --pattern=<pattern>     Template pattern (default: solver-type-plugin)
                          Supported: solver-type-plugin, runtime-plugin
  --solver-type=<value>   SolverType this plug-in targets (default: swe-rebench-v2.v1;
                          ignored for runtime-plugin)

Common:
  --out-dir=<path>        Where to write the package (default: cwd)
  --help                  Show this help

Examples:
  jinn create harness @example/forecaster
  jinn create plugin  @example/my-skill
  jinn create plugin  @example/my-runtime --pattern runtime-plugin

Quickstart (placeholder until 52x3.6 ships):
  https://github.com/Jinn-Network/mono/blob/main/cargo/docs/build/quickstart.md
`;
```

- [ ] **Step 2: Update the `run` function to dispatch on subcommand**

Replace `run` (around line 186) with:

```typescript
async function run(ctx: CommandContext): Promise<void> {
  const sub = ctx.argv[0];
  if (!sub || sub === '--help' || ctx.argv.includes('--help')) {
    ctx.writer.write(HELP_TEXT);
    return;
  }
  if (sub !== 'harness' && sub !== 'plugin') {
    ctx.writer.write(
      `error: unknown subcommand '${sub}' (expected 'harness' or 'plugin')\n`,
    );
    ctx.writer.write(HELP_TEXT);
    ctx.exit(1);
    return;
  }
  const packageName = ctx.argv[1];
  if (!packageName || packageName.startsWith('--')) {
    ctx.writer.write(`error: package name required\n`);
    ctx.writer.write(HELP_TEXT);
    ctx.exit(1);
    return;
  }

  const defaultPattern = sub === 'harness' ? 'forecaster' : 'solver-type-plugin';
  const defaultSolverType = sub === 'harness' ? 'prediction.v1' : 'swe-rebench-v2.v1';

  let parsed;
  try {
    parsed = parseArgs({
      args: ctx.argv.slice(2),
      options: {
        ...COMMON_FLAGS,
        pattern: { type: 'string' as const, default: defaultPattern },
        'solver-type': { type: 'string' as const, default: defaultSolverType },
        network: { type: 'string' as const, default: 'base-sepolia' },
        'out-dir': { type: 'string' as const },
      },
      allowPositionals: false,
    });
  } catch (err) {
    ctx.writer.write(`error: ${(err as Error).message}\n`);
    ctx.exit(1);
    return;
  }
  const flags = parsed.values;
  const outDir = String(flags['out-dir'] ?? process.cwd());
  const pattern = String(flags.pattern ?? defaultPattern);

  if (sub === 'harness') {
    if (!SUPPORTED_PATTERNS.includes(pattern as HarnessPattern)) {
      ctx.writer.write(
        `error: unsupported --pattern '${pattern}' (supported: ${SUPPORTED_PATTERNS.join(', ')})\n`,
      );
      ctx.exit(1);
      return;
    }
  } else {
    if (!SUPPORTED_PLUGIN_PATTERNS.includes(pattern as PluginPattern)) {
      ctx.writer.write(
        `error: unsupported --pattern '${pattern}' (supported: ${SUPPORTED_PLUGIN_PATTERNS.join(', ')})\n`,
      );
      ctx.exit(1);
      return;
    }
  }

  let target: string;
  try {
    target = await runCreate({
      target: sub,
      pattern: pattern as HarnessPattern | PluginPattern,
      packageName,
      solverTypeString: String(flags['solver-type'] ?? defaultSolverType),
      network: sub === 'harness' ? String(flags.network ?? 'base-sepolia') : undefined,
      outDir,
    });
  } catch (err) {
    ctx.writer.write(`error: ${(err as Error).message}\n`);
    ctx.exit(1);
    return;
  }
  ctx.writer.write(
    `Created ${packageName} at ${target}\nNext: cd ${target} && yarn install && yarn test\n`,
  );
}
```

- [ ] **Step 3: Update the `summary` field on the command export**

Change the `createCommand` definition:

```typescript
export const createCommand: CommandModule = {
  name: 'create',
  summary: 'Scaffold a new Jinn external harness or SolverPlugin package',
  helpText: HELP_TEXT,
  run,
};
```

- [ ] **Step 4: Typecheck and run all tests**

```bash
cd client && yarn typecheck 2>&1 | tail -5
yarn vitest run test/cli/commands/create.test.ts --reporter=verbose 2>&1 | tail -20
yarn test 2>&1 | tail -5
```

Expected: typecheck clean; all create.test.ts cases pass; full test suite green.

- [ ] **Step 5: Commit**

```bash
git add client/src/cli/commands/create.ts
git commit -m "feat(et6s): jinn create plugin CLI subcommand + help text"
```

---

## Task 8: Verify the binary works end-to-end manually

**Files:** None (manual verification).

- [ ] **Step 1: Build and exercise the binary**

```bash
cd client
yarn build 2>&1 | tail -5
node dist/bin/jinn.js create plugin /tmp/sanity-check-plugin --pattern solver-type-plugin --solver-type swe-rebench-v2.v1
ls /tmp/sanity-check-plugin
cat /tmp/sanity-check-plugin/jinn.plugin.json
```

Expected: directory created with the expected file tree; `jinn.plugin.json` shows `swe-rebench-v2.v1` in `jinn.supports`; no `{{}}` strings present.

- [ ] **Step 2: Clean up + commit no-op if anything was missed**

```bash
rm -rf /tmp/sanity-check-plugin
# If yarn build added any incidental changes, commit them:
git status
```

If `git status` shows incidental changes (typically not), commit them as `chore(et6s): build artifacts`. Otherwise skip.

---

## Task 9: Update bd state + open PR

**Files:** bd state + a PR.

- [ ] **Step 1: Push the branch**

```bash
git push -u origin feat/et6s-create-plugin-scaffold 2>&1 | tail -3
```

- [ ] **Step 2: Open the PR (stacked on the 52x3 docs branch)**

```bash
gh pr create \
  --base feat/52x3-plug-in-builder-entry-point \
  --head feat/et6s-create-plugin-scaffold \
  --title "feat(et6s): jinn create plugin scaffold (two patterns)" \
  --body "$(cat <<'EOF'
Implements [#201](https://github.com/Jinn-Network/mono/issues/201) (`jinn-mono-et6s`) — the first child of the [Plug-in builder entry point epic](https://github.com/Jinn-Network/mono/issues/199) (`jinn-mono-52x3`).

## Summary

Extends `jinn create` with a `plugin` target, two patterns (`solver-type-plugin`, `runtime-plugin`). Builders go from zero to a working scaffolded package in one command.

## What ships

- `client/templates/plugins/{solver-type-plugin,runtime-plugin}/` — template files.
- `client/src/cli/commands/create.ts` — extended to dispatch on `target: 'harness' | 'plugin'`.
- `client/test/cli/commands/create.test.ts` — three new describe blocks; including a first-run \`yarn install && yarn test\` E2E for both patterns.

## Test plan

- [x] \`yarn typecheck\` clean
- [x] \`yarn vitest run test/cli/commands/create.test.ts\` — all describes pass
- [x] \`yarn test\` — full suite green
- [x] Manual: \`node dist/bin/jinn.js create plugin /tmp/sanity --pattern solver-type-plugin\` produces a valid package; running \`yarn install && yarn test\` in the scaffolded dir passes.

## Stacked on

[`feat/52x3-plug-in-builder-entry-point`](#199-tracking) — the epic docs branch. Merge that first (or merge this directly to main and the docs propagate together).

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)" 2>&1 | tail -3
```

- [ ] **Step 3: Mark bd in-progress → close on PR merge**

bd status was set to `in_progress` at planning time. Mark `closed` after PR merges. Until then, leave open.

```bash
# After PR merges to main:
# bd close jinn-mono-et6s
```

---

## Self-review

**Spec coverage:**
- §6.2 (`jinn create plugin <name>` scaffold) — Tasks 1–8 cover both patterns + CLI surface + E2E.
- Acceptance criteria from the et6s bead body: each criterion has a matching task/step.
- `jinn create plugin --help` printing the quickstart URL: Task 7 Step 1 (with a placeholder URL noted in spec §9 — the canonical URL comes from `52x3.6`).
- `yarn typecheck` + `yarn test` green: Task 7 Step 4.

**Placeholder scan:** no TBD / TODO. The README quickstart URL is intentionally a placeholder pending `52x3.6`; the placeholder is explicit and self-flagged.

**Type consistency:** `PluginPattern`, `SUPPORTED_PLUGIN_PATTERNS`, `pluginTemplateFiles`, `RunCreateArgs` extended shape — used consistently across Tasks 4, 5, 7.

---

*End of plan.*
