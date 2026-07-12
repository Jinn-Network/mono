/**
 * Guard test for the production Dockerfile CMD (issue #652).
 *
 * The indexer's production image must launch with Ponder's zero-downtime
 * views pattern wired in: `ponder start --views-schema=jinn_indexer`. This
 * automates the recovery runbook's manual `ponder db create-views` step and
 * keeps the public-facing `jinn_indexer` views swinging to the new data
 * schema on `/ready` for external SQL consumers.
 *
 * The flag spelling is load-bearing — `--views-schema` (kebab). A regression
 * that drops the flag, or that points the data schema at the views schema,
 * silently reverts the deploy to the manual-swap footgun, so we pin the CMD
 * line shape from disk rather than trusting a comment.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dockerfilePath = path.join(__dirname, '..', 'deploy', 'Dockerfile');

function readCmdLine(): string {
  const contents = readFileSync(dockerfilePath, 'utf8');
  const cmdLine = contents
    .split('\n')
    .find((line) => line.trimStart().startsWith('CMD '));
  if (!cmdLine) throw new Error('no CMD line found in deploy/Dockerfile');
  return cmdLine;
}

describe('deploy/Dockerfile CMD (issue #652)', () => {
  it('invokes ponder.js start', () => {
    const cmd = readCmdLine();
    expect(cmd).toContain('ponder.js');
    expect(cmd).toContain('start');
  });

  it('wires the zero-downtime views pattern via --views-schema=jinn_indexer', () => {
    const cmd = readCmdLine();
    expect(cmd).toContain('--views-schema=jinn_indexer');
  });

  // #1429: the CMD auto-derives DATABASE_SCHEMA from ponder.schema.ts at boot
  // (shell form so the derive + export + exec run), rather than pinning a
  // manual name. The assignment MUST be the standalone command-substitution
  // form `DATABASE_SCHEMA="$(...)"` — NOT `export DATABASE_SCHEMA="$(...)"`.
  // In `export VAR="$(cmd)"` the statement's exit status is export's (always
  // 0), so a non-zero exit from derive-schema.mjs is swallowed and the real
  // process execs with an empty DATABASE_SCHEMA (silent mis-target). Pinning
  // the assignment form here prevents regressing back to that footgun.
  it('fail-loud derives DATABASE_SCHEMA before exec-ing ponder', () => {
    const cmd = readCmdLine();
    expect(cmd).toContain('DATABASE_SCHEMA="$(node deploy/derive-schema.mjs)"');
    expect(cmd).not.toContain('export DATABASE_SCHEMA="$(');
    expect(cmd).toContain('exec node');
    expect(cmd).toContain('--views-schema=jinn_indexer');
  });
});
