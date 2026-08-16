/**
 * Unified MCP-server-script writer for the claude-mcp-prediction* impls.
 *
 * Both `claude-mcp-prediction` and `claude-mcp-prediction-apy` generate a
 * wrapper `.mjs` that plain Node loads via `--mcp-config`. The wrapper imports
 * `startMcpServer` from the venue's COMPILED `mcp-tools.js` sitting next to the
 * caller and hands it the config path from argv[2].
 *
 * The only per-venue differences were the cosmetic header comment + usage
 * string (the `serverLabel`), and the caller's own module URL used to resolve
 * the sibling `mcp-tools.js`. Both are parameters here.
 */

import { writeFileSync, existsSync, chmodSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface WriteMcpServerScriptOptions {
  /**
   * The CALLING venue `index.ts`'s `import.meta.url`. Resolution of the sibling
   * compiled `mcp-tools.js` is relative to THIS url — never this shared
   * module's — so the wrapper loads the venue's own tools.
   */
  callerFileUrl: string;
  /**
   * Cosmetic label interpolated into the header comment + usage string
   * (e.g. `jinn-prediction`, `jinn-apy-prediction`).
   */
  serverLabel: string;
}

/**
 * Generate a wrapper script that spawns the venue's MCP server.
 *
 * Resolves the COMPILED `mcp-tools.js` path relative to `callerFileUrl`. The
 * wrapper is spawned by plain Node (not tsx) via `--mcp-config`, so it must
 * import a `.js` file. After `yarn build` the compiled artifact lives at
 * `dist/.../mcp-tools.js`.
 *
 * - Production (running from dist/): callerFile is in /.../dist/... → sibling
 *   mcp-tools.js exists.
 * - Dev/test (running source via tsx/vitest): callerFile is in /.../src/... →
 *   rewrite path into /.../dist/... .
 */
export function writeMcpServerScript(outPath: string, opts: WriteMcpServerScriptOptions): void {
  const __filename = fileURLToPath(opts.callerFileUrl);

  let mcpToolsPath = join(dirname(__filename), 'mcp-tools.js');
  if (!existsSync(mcpToolsPath) && __filename.includes(`${'/'}src${'/'}`)) {
    mcpToolsPath = __filename
      .replace(`${'/'}src${'/'}`, `${'/'}dist${'/'}`)
      .replace(/index\.(ts|js)$/, 'mcp-tools.js');
  }

  if (!existsSync(mcpToolsPath)) {
    throw new Error(
      `E_DAEMON_MUST_RUN_FROM_DIST: ${mcpToolsPath} does not exist. ` +
        `The ${opts.serverLabel} wrapper subprocess loads this compiled artifact. ` +
        `Run \`yarn build\` before starting the daemon or isolation test.`,
    );
  }

  const wrapperBasename = basename(outPath);
  const script = `#!/usr/bin/env node
// Auto-generated ${opts.serverLabel} MCP wrapper — do not edit.
// Delegates to the compiled mcp-tools module; no business logic in the wrapper.
// Config is read from argv[2].
import { readFileSync } from 'node:fs';
import { startMcpServer } from ${JSON.stringify(mcpToolsPath)};

const configPath = process.argv[2];
if (!configPath) {
  process.stderr.write('Usage: ${wrapperBasename} <config-file-path>\\n');
  process.exit(1);
}

const config = JSON.parse(readFileSync(configPath, 'utf-8'));
await startMcpServer(config);
`.trim();

  writeFileSync(outPath, script, { encoding: 'utf-8', mode: 0o600 });
  chmodSync(outPath, 0o600);
}
