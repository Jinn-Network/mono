import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { writeMcpServerScript } from '../../../../src/harnesses/impls/claude-mcp-shared/mcp-server-script.js';

describe('writeMcpServerScript', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'mcp-server-script-test-'));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('emits a wrapper that imports the sibling compiled mcp-tools.js', () => {
    // A caller dir that already contains a compiled sibling mcp-tools.js.
    const callerDir = join(tmpDir, 'dist-like');
    mkdirSync(callerDir, { recursive: true });
    const siblingToolsPath = join(callerDir, 'mcp-tools.js');
    writeFileSync(siblingToolsPath, '// stub compiled mcp-tools\n');

    const callerFileUrl = pathToFileURL(join(callerDir, 'index.js')).href;
    const outPath = join(tmpDir, 'server.mjs');

    writeMcpServerScript(outPath, { callerFileUrl, serverLabel: 'jinn-prediction' });

    const script = readFileSync(outPath, 'utf-8');
    expect(script).toContain('import { startMcpServer } from');
    // The import target must be the sibling mcp-tools.js next to the caller.
    expect(script).toContain(JSON.stringify(siblingToolsPath));
  });

  it('rewrites a /src/ caller path to /dist/ to resolve the sibling mcp-tools.js', () => {
    // Caller lives under /src/ with NO sibling mcp-tools.js; the compiled
    // sibling exists under the mirrored /dist/ path. The resolver must rewrite.
    const srcDir = join(tmpDir, 'src', 'venue');
    const distDir = join(tmpDir, 'dist', 'venue');
    mkdirSync(srcDir, { recursive: true });
    mkdirSync(distDir, { recursive: true });
    const distToolsPath = join(distDir, 'mcp-tools.js');
    writeFileSync(distToolsPath, '// stub compiled mcp-tools\n');

    const callerFileUrl = pathToFileURL(join(srcDir, 'index.ts')).href;
    const outPath = join(tmpDir, 'server.mjs');

    expect(() =>
      writeMcpServerScript(outPath, { callerFileUrl, serverLabel: 'jinn-prediction' }),
    ).not.toThrow();

    const script = readFileSync(outPath, 'utf-8');
    // The import target must be the /dist/ sibling, not the /src/ caller dir.
    expect(script).toContain(JSON.stringify(distToolsPath));
    expect(script).not.toContain(join(srcDir, 'mcp-tools.js'));
  });

  it('throws E_DAEMON_MUST_RUN_FROM_DIST when the sibling mcp-tools.js is absent', () => {
    // A caller dir with NO sibling mcp-tools.js and no /src/ segment to rewrite.
    const callerDir = join(tmpDir, 'no-tools');
    mkdirSync(callerDir, { recursive: true });
    const callerFileUrl = pathToFileURL(join(callerDir, 'index.js')).href;
    const outPath = join(tmpDir, 'server.mjs');

    expect(() =>
      writeMcpServerScript(outPath, { callerFileUrl, serverLabel: 'jinn-prediction' }),
    ).toThrow(/E_DAEMON_MUST_RUN_FROM_DIST/);
  });
});
