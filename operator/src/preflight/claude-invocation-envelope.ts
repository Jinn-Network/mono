/**
 * Build and emit the `invalid_invocation` envelope when the Claude CLI
 * preflight fails. Shared by `main.ts` and unit tests so the contract stays
 * in one place (spec §6 / §6.2 / §7.6).
 */

import { homedir } from 'node:os';
import { dirname, isAbsolute, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { emitEnvelope, type EnvelopeSinks } from '../errors/envelope.js';
import { STATE_DIR_NAME, LEGACY_STATE_DIR_NAME } from '../state-dir.js';

const THIS_DIR = dirname(fileURLToPath(import.meta.url));
const ENVELOPE_INSTALL_ROOT = normalize(resolve(THIS_DIR, '..', '..'));
const ENVELOPE_STATE_HOMES = [
  normalize(resolve(join(homedir(), STATE_DIR_NAME))),
  normalize(resolve(join(homedir(), LEGACY_STATE_DIR_NAME))),
];

function envelopePathUnderRoot(absPath: string, root: string): boolean {
  const p = normalize(resolve(absPath));
  const r = normalize(resolve(root));
  if (p === r) return true;
  const prefix = r.endsWith(sep) ? r : r + sep;
  return p.startsWith(prefix);
}

function isEnvelopeSensitivePath(absPath: string): boolean {
  return (
    envelopePathUnderRoot(absPath, ENVELOPE_INSTALL_ROOT)
    || ENVELOPE_STATE_HOMES.some((home) => envelopePathUnderRoot(absPath, home))
  );
}

/** §7.6 — omit forbidden absolute paths from envelope `details.attempted`. */
export function sanitizedClaudeAttemptedForEnvelope(claudePath: string): string {
  const t = claudePath.trim();
  if (!t) return 'configured path';
  if (isAbsolute(t) && isEnvelopeSensitivePath(t)) {
    return 'configured path';
  }
  return t;
}

/** §7.6 — `invalid_invocation.message` must not echo forbidden absolute paths. */
export function sanitizedClaudePreflightMessageForEnvelope(detail: string, claudePath: string): string {
  let out = detail;
  const t = claudePath.trim();

  const replaceAll = (s: string, find: string, rep: string) => (find ? s.split(find).join(rep) : s);

  if (isAbsolute(t) && isEnvelopeSensitivePath(t)) {
    const variants = new Set<string>([t, normalize(t)]);
    try {
      variants.add(normalize(resolve(t)));
    } catch {
      /* ignore */
    }
    for (const v of [...variants].filter(Boolean).sort((a, b) => b.length - a.length)) {
      out = replaceAll(out, v, 'configured path');
    }
  }

  for (const home of ENVELOPE_STATE_HOMES) {
    out = replaceAll(out, home, 'configured path');
  }
  out = replaceAll(out, ENVELOPE_INSTALL_ROOT, 'configured path');
  return out;
}

export function emitClaudeBinaryPreflightFailure(
  detail: string,
  claudePath: string,
  sinks: EnvelopeSinks = {},
): never {
  emitEnvelope(
    {
      code: 'invalid_invocation',
      message: sanitizedClaudePreflightMessageForEnvelope(detail, claudePath),
      hint: 'Install Claude Code CLI on your PATH, or set the CLI binary path in your configuration file.',
      exampleCli: 'command -v claude',
      details: {
        field: 'claude_binary',
        expected: 'executable claude binary',
        attempted: sanitizedClaudeAttemptedForEnvelope(claudePath),
      },
    },
    sinks,
  );
}
