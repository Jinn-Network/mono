import { describe, expect, it } from 'vitest';
import { writeFileSync, mkdtempSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { checkClaudeBinary } from '../../src/preflight/claude-binary.js';

describe('checkClaudeBinary', () => {
  it('returns ok=true when the path points at an executable file', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'jinn-preflight-'));
    const fakeClaude = join(dir, 'claude');
    writeFileSync(fakeClaude, '#!/bin/sh\necho fake\n');
    chmodSync(fakeClaude, 0o755);

    const result = await checkClaudeBinary(fakeClaude);
    expect(result.ok).toBe(true);
    expect(result.resolvedPath).toBe(fakeClaude);
  });

  it('returns ok=false when the path does not exist', async () => {
    const result = await checkClaudeBinary('/nonexistent/path/to/claude');
    expect(result.ok).toBe(false);
    expect(result.detail).toContain('not found');
  });

  it('resolves a bare binary name via PATH when it exists', async () => {
    // `node` is guaranteed present in the test env
    const result = await checkClaudeBinary('node');
    expect(result.ok).toBe(true);
    expect(result.resolvedPath).toBeDefined();
  });

  it('returns ok=false for a bare binary name not on PATH', async () => {
    const result = await checkClaudeBinary('definitely-not-a-real-binary-xyz');
    expect(result.ok).toBe(false);
    expect(result.detail).toContain('not found');
  });
});
