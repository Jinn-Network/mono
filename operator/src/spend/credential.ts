import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import {
  CLAUDE_CODE_HARNESS,
  CODEX_HARNESS,
  HERMES_AGENT_HARNESS,
  canonicalHarnessName,
} from '../harnesses/names.js';

/** A credential identity. Format: `{provider}:{authMethod}`, e.g. `anthropic:api-key`. Never empty. */
export type CredentialId = string;

/**
 * Does this operator have Claude Code installed and authed via OAuth?
 *
 * The `claude` CLI keeps its OAuth token in the OS keyring on macOS, in
 * platform-equivalent stores elsewhere, and writes per-user state under
 * `~/.claude/`. The cheapest cross-platform "operator has an active
 * Claude Code Pro subscription set up" probe is "does `~/.claude/`
 * exist?" — it's created by `claude` on first run and persists.
 *
 * Injectable for tests via `homeDirOverride`.
 */
export function hasClaudeCodeOnDisk(homeDirOverride?: string): boolean {
  return existsSync(join(homeDirOverride ?? homedir(), '.claude'));
}

/**
 * Does this operator have Codex CLI installed and authed?
 *
 * Codex CLI writes OAuth to `$CODEX_HOME/auth.json` in hosted deploys or
 * `~/.codex/auth.json` locally. Presence is the subscription signal.
 */
export function hasCodexOnDisk(homeDirOverride?: string): boolean {
  return hasCodexAuthFile(process.env, homeDirOverride);
}

function hasCodexAuthFile(env: NodeJS.ProcessEnv, homeDirOverride?: string): boolean {
  const codexHome = env['CODEX_HOME']?.trim();
  if (codexHome && existsSync(join(codexHome, 'auth.json'))) return true;
  return existsSync(join(homeDirOverride ?? homedir(), '.codex', 'auth.json'));
}

/**
 * Resolve which authentication credential a harness will bill against.
 *
 * Precedence per provider (preserved from PR #345 / #474):
 *   1. subscription token env var (`*:subscription`) — most explicit
 *      subscription marker; the operator has deliberately set it
 *   2. raw-API-key env var (`*:api-key`) — explicit api-key
 *   3. on-disk OAuth (`*:subscription`) — the typical operator who
 *      installed `claude` / `codex` CLI and never set an env var
 *   4. null — no credential resolved
 *
 * Returns null when the harness makes no paid LLM call (e.g. prediction
 * harnesses) or no credential is recognisable. Issue #901: disk
 * detection added so stock subscription installs get a credential and
 * the AI-units gate engages by default; precedence above kept stable so
 * the cost-surface UI from #345 / #474 still reads the same.
 */
export function resolveCredentialId(
  harness: string | undefined,
  env: NodeJS.ProcessEnv,
  homeDirOverride?: string,
): CredentialId | null {
  if (!harness) return null;
  switch (canonicalHarnessName(harness)) {
    case CLAUDE_CODE_HARNESS:
      if (env['CLAUDE_CODE_OAUTH_TOKEN']) return 'anthropic:subscription';
      if (env['ANTHROPIC_API_KEY']) return 'anthropic:api-key';
      if (hasClaudeCodeOnDisk(homeDirOverride)) return 'anthropic:subscription';
      return null;
    case CODEX_HARNESS:
      if (env['OPENAI_API_KEY']) return 'openai:api-key';
      if (hasCodexAuthFile(env, homeDirOverride)) return 'openai:subscription';
      return null;
    case HERMES_AGENT_HARNESS: {
      const provider = (env['JINN_HERMES_PROVIDER'] ?? 'hermes').trim().toLowerCase();
      return `${provider}:api-key`;
    }
    default:
      return null;
  }
}
