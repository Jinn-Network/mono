import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdirSync, writeFileSync, existsSync, cpSync } from 'node:fs';
import type { DispatcherConfig, Effort } from './types.js';

/**
 * Per-session `$HERMES_HOME` for a Hermes coordinator session.
 *
 * Hermes has no CLI flag for reasoning effort and no env override — it reads
 * `agent.reasoning_effort` from `$HERMES_HOME/config.yaml` (hermes_cli/cli.py).
 * So routing the board's Effort to a hermes session REQUIRES writing a config
 * file, which in turn requires a per-session home (two concurrent sessions at
 * different efforts must not share one). The home also carries the toolset,
 * skill-dir, and MCP wiring that make the session a real coordinator.
 *
 * This is a deliberately *fresh* config, not a deep-merge of the operator's
 * `~/.hermes/config.yaml` (the client daemon's `writePerTaskHermesConfig` does
 * merge, because marketplace solves must honour operator provider/base_url
 * choices). Here the dispatcher owns every knob that matters and hermes'
 * built-in defaults cover the rest — merging would let an operator's stray
 * `model.default` or `platform_toolsets` silently retarget a dispatched
 * session. Credentials are the exception: they are NOT written here. The
 * OpenRouter key reaches the child by plain env inheritance from the
 * supervisor (`sessionSpawnEnv` copies `process.env`).
 */

const HERE = dirname(fileURLToPath(import.meta.url));
// src/dispatcher → src → packages/autopilot → packages → repo root
const REPO_ROOT = join(HERE, '..', '..', '..', '..');

/** Root for per-session hermes homes — sibling of SESSIONS_LOG_DIR. */
export const HERMES_HOMES_DIR = join(homedir(), '.jinn-client', 'autopilot', 'hermes-homes');

/**
 * Operator hermes state seeded into each session home when present.
 *
 * - `.env` — **load-bearing**: hermes reads provider keys from
 *   `$HERMES_HOME/.env` via python-dotenv. The OpenRouter key typically lives
 *   ONLY here, not in the shell env, so a home without it dies ~14s into the
 *   first turn with "Provider resolver returned an empty API key". We copy the
 *   file rather than read it — the dispatcher never handles the secret value.
 *   (The client daemon merges operator `.env` into its per-task `.env` for the
 *   same reason; this is the same guarantee, by copy.)
 * - `auth`, `auth.json` — OAuth/provider credential state.
 * - `bin` — carries `tirith`, the shell-command scanner hermes runs before
 *   every terminal call. Seeding it keeps that guard active in the session.
 */
const OPERATOR_STATE_TO_SEED = ['.env', 'auth', 'auth.json', 'bin'] as const;

/**
 * Map the board's Effort to hermes' reasoning effort.
 *
 * `VALID_REASONING_EFFORTS = minimal|low|medium|high|xhigh`
 * (hermes_cli/hermes_constants.py). Note **`max` is NOT valid** — hermes
 * silently degrades an unknown value to its provider default, so the board's
 * `Max` is mapped to `xhigh` (its highest real tier) rather than passed
 * through and quietly lost. Returns null when a session has no Effort, so the
 * key is omitted and Hermes uses its own default.
 */
export function hermesReasoningEffort(effort: Effort | null): string | null {
  switch (effort) {
    case 'Low': return 'low';
    case 'Medium': return 'medium';
    case 'High': return 'high';
    case 'XHigh': return 'xhigh';
    case 'Max': return 'xhigh'; // 'max' is not a hermes tier — xhigh is the ceiling
    default: return null;
  }
}

/** Minimal YAML emitter for the flat/nested-object config we generate. Avoids
 *  adding a yaml dep to this package for one writer. Values are strings,
 *  numbers, booleans, or arrays of strings — no user free-text reaches it
 *  except paths and the model id, which are quoted. */
function toYaml(value: unknown, indent = 0): string {
  const pad = '  '.repeat(indent);
  if (Array.isArray(value)) {
    if (value.length === 0) return ' []\n';
    return '\n' + value.map((v) => `${pad}- ${JSON.stringify(v)}\n`).join('');
  }
  if (value !== null && typeof value === 'object') {
    let out = '\n';
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      const rendered = toYaml(v, indent + 1);
      out += `${pad}${k}:${rendered.startsWith('\n') ? '' : ' '}${rendered.replace(/^ /, '')}`;
    }
    return out;
  }
  return ` ${JSON.stringify(value)}\n`;
}

export interface HermesHomeOpts {
  /** Namespaced coordinator identity, e.g. implement-42 or review-42. */
  sessionId: string;
  worktreePath: string;
  effort: Effort | null;
  cfg: DispatcherConfig;
  /** Override the operator home to seed from (tests). Default `~/.hermes`. */
  operatorHome?: string;
  /** Override the repo root whose `.claude/skills` is exposed (tests). */
  repoRoot?: string;
}

/**
 * Create `<HERMES_HOMES_DIR>/<sessionId>` with a generated `config.yaml`, seeding
 * operator auth/bin when available. Returns the home path to set as
 * `HERMES_HOME` on the spawned session. Idempotent: re-dispatching a session
 * rewrites the config (effort may have changed) but never clobbers seeded state.
 */
export function prepareHermesHome(opts: HermesHomeOpts): { hermesHome: string } {
  const { sessionId, worktreePath, effort, cfg } = opts;
  const operatorHome = opts.operatorHome ?? join(homedir(), '.hermes');
  const repoRoot = opts.repoRoot ?? REPO_ROOT;
  const hermesHome = join(HERMES_HOMES_DIR, sessionId);

  mkdirSync(hermesHome, { recursive: true });

  // Seed operator state (credentials + the tirith command scanner). Skip any
  // entry that is absent or already seeded — never overwrite.
  for (const entry of OPERATOR_STATE_TO_SEED) {
    const src = join(operatorHome, entry);
    const dest = join(hermesHome, entry);
    if (existsSync(src) && !existsSync(dest)) {
      cpSync(src, dest, { recursive: true });
    }
  }

  const reasoning = hermesReasoningEffort(effort);
  const config: Record<string, unknown> = {
    // provider is ALSO pinned here (not just on the CLI) so the session cannot
    // fall back to inference — an `<org>/<model>`-shaped id infers `openrouter`
    // and would bill an API key instead of the operator's Codex subscription.
    // `openai-codex` auto-selects api_mode=codex_responses and the Codex
    // base_url (runtime_provider.py), so neither is set here. Credentials come
    // from hermes' own Codex token store in the seeded auth.json.
    model: { default: cfg.hermesModel, provider: cfg.hermesProvider },
    agent: {
      // Board Effort → reasoning effort (the whole reason this file exists).
      ...(reasoning != null ? { reasoning_effort: reasoning } : {}),
      // Default is 90 tool-calling iterations per turn; a coordinator that
      // triages, delegates every stage, and ships a PR can exceed that on a
      // heavy issue. Raise deliberately — children get their own budget
      // (delegation.max_iterations), so this bounds the coordinator only.
      max_turns: 400,
    },
    terminal: { backend: 'local', cwd: worktreePath },
    platform_toolsets: {
      // The client daemon pins a narrower allowlist for marketplace solves and
      // deliberately EXCLUDES `delegation` (untrusted solver code must not fan
      // out). A coordinator is the opposite case: `delegation` is what gives it
      // native subagents for the stage pipeline, so it is included here on
      // purpose. Do not "align" the two lists.
      'hermes-cli': [
        'terminal', 'file', 'web', 'skills', 'memory',
        'session_search', 'todo', 'code_execution', 'delegation',
      ],
    },
    // Hermes's default max_spawn_depth=1 is process-local. Lightweight coordinator
    // children are leaves, while Stages 1/3/4/5 launch as fresh depth-0 OS
    // processes through stage:run and may each fan out their own depth-1 children.
    // Do not raise depth to compensate for launching a stage incorrectly as a child.
    delegation: { max_concurrent_children: 3 },
    skills: {
      // Hermes scans SKILL.md trees natively — this is how the coordinator
      // loads canonical workflow skills, the shared runtime adapter, and
      // composed repository skills such as `testing-jinn-app`.
      external_dirs: [join(repoRoot, '.claude', 'skills')],
    },
    mcp_servers: {
      // Stage 7 (operator-visible surfaces) drives the browser through this.
      'chrome-devtools': { command: 'npx', args: ['-y', 'chrome-devtools-mcp@latest'] },
    },
  };

  let yaml = '# Generated per-session by the Jinn autopilot dispatcher — do not edit.\n';
  yaml += `# Session: ${sessionId}. Regenerated on every dispatch.\n`;
  for (const [k, v] of Object.entries(config)) {
    const rendered = toYaml(v, 1);
    yaml += `${k}:${rendered.startsWith('\n') ? '' : ' '}${rendered.replace(/^ /, '')}`;
  }
  writeFileSync(join(hermesHome, 'config.yaml'), yaml, { mode: 0o600 });

  return { hermesHome };
}
