// client/src/harnesses/impls/hermes-agent/bootstrap.ts
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse as yamlParse, stringify as yamlStringify } from 'yaml';
import {
  hermesConfigFromSolverPlugins,
  type ConfigBuilderEnv,
  type HermesConfigSnippet,
} from './config-builder.js';

/**
 * Toolset allowlist for Jinn-run Hermes sessions.
 *
 * Hermes's default-ON toolset surface is broader than Claude Code's built-ins
 * and includes footguns under unattended automation (`messaging` can send
 * messages; `cronjob` can schedule things; `computer_use`, `browser`,
 * `tts`/`vision`/`image_gen` are out of scope for text code-issue tasks). We
 * pin an explicit allowlist for `hermes-cli` (the platform Jinn spawns Hermes
 * as); operators who want to expand it for a Jinn task can request a daemon
 * config option later — they can NOT widen the allowlist by editing their
 * `~/.hermes/config.yaml`'s `platform_toolsets.hermes-cli` because Jinn
 * deliberately replaces that key (other `platform_toolsets.*` entries — e.g.
 * for `hermes-telegram` — pass through unchanged).
 */
const TOOLSET_ALLOWLIST = [
  'terminal',
  'file',
  'web',
  'skills',
  'memory',
  'session_search',
  'todo',
  'code_execution',
] as const;

/**
 * Files copied verbatim from the operator's real Hermes home into the per-Task
 * `$HERMES_HOME`. Hermes resolves OAuth creds from `$HERMES_HOME/auth/...` and
 * pooled creds from `$HERMES_HOME/auth.json` with NO real-home fallback, so a
 * fresh per-Task home (which the freeze contract requires) would otherwise
 * have no credentials and Hermes would fail with "No … credentials found."
 *
 * `bin/` carries Hermes-managed binaries — most importantly `bin/tirith`, the
 * shell-command security scanner Hermes runs before every `terminal_tool`
 * invocation. Hermes resolves it from `$HERMES_HOME/bin/tirith` and falls back
 * to an auto-download from `github.com/sheeki03/tirith/releases/latest` on
 * first use. Without seeding, every per-Task run pays the multi-MB download
 * cost on its first shell command — long enough to blow the harness budget.
 *
 * Hermes may refresh OAuth access tokens mid-task. The HermesHarness excludes
 * these runtime-only files from the daemon state digest while still fencing the
 * learning surface (memories/, skills/, sessions/, and ordinary files). The
 * binary exception is intentionally limited to Hermes's managed `bin/tirith`
 * security scanner instead of the whole `bin/` tree.
 */
const OPERATOR_STATE_TO_SEED = ['auth', 'auth.json', 'bin'] as const;

export interface WritePerTaskConfigInputs {
  hermesHome: string;
  workingDir: string;
  model?: string;
  provider?: string;
  solverPluginRoots: readonly string[];
  env: ConfigBuilderEnv;
  /**
   * The operator's real Hermes home (typically `process.env.HERMES_HOME` or
   * `~/.hermes`). The operator's `config.yaml`, `.env`, and `auth/` are
   * inherited from here — see the merge contract in `mergePerTaskConfig`.
   * Omit (or pass a path equal to `hermesHome`) to skip inheritance — useful
   * in tests.
   */
  seedFrom?: string;
}

function seedOperatorState(hermesHome: string, seedFrom: string): void {
  if (seedFrom === hermesHome || !existsSync(seedFrom)) return;
  for (const name of OPERATOR_STATE_TO_SEED) {
    const src = join(seedFrom, name);
    const dst = join(hermesHome, name);
    if (existsSync(src) && !existsSync(dst)) {
      cpSync(src, dst, { recursive: true });
    }
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Operator config.yaml inheritance — the merge contract.
// ────────────────────────────────────────────────────────────────────────────
//
// Goal: anything the operator set in `~/.hermes/config.yaml` flows into the
// per-Task config, EXCEPT for the small set of keys Jinn must own per Task.
// This is the comprehensive form of operator-config inheritance — it replaces
// the prior "fresh per-Task config with hand-written Jinn fields only" path,
// which was a whack-a-mole source (auth/, then .env, then max_tokens; each
// real-binary run surfaced another orphaned setting). With the merge, ANY
// operator setting (model.max_tokens, model.context_length, model.base_url,
// provider_routing, openrouter.response_cache, agent.iteration_budget,
// compression.threshold, auxiliary.*, display.*, voice.*, security.*,
// approvals.*, delegation.*, web.*, custom providers: overrides, etc.) just
// flows through.
//
// Jinn-managed keys (per-Task authoritative; Jinn writes these every Task):
//   - model.default        — if a daemon/SolverNet override was provided
//   - model.provider       — if a daemon/SolverNet override was provided
//   - terminal.backend     — forced to `local` (the per-Task workingDir is a
//                            host filesystem path; remote backends would need
//                            additional setup Jinn doesn't yet do)
//   - terminal.cwd         — the per-Task workingDir
//   - platform_toolsets['hermes-cli']   — the Jinn allowlist (replaces any
//                            operator value; other platforms pass through)
//   - mcp_servers.<name>   — operator's MCP servers preserved; Jinn adds its
//                            SolverPlugin MCP servers; Jinn wins on collision
//   - skills.external_dirs — operator's dirs preserved; Jinn appends the
//                            SolverPlugin skill dirs
//
// Everything else from the operator's config.yaml passes through unchanged.
//
// Operator-set keys that DO inherit and matter for budget-capped providers:
//   - model.max_tokens     — OpenRouter pre-bills on max_tokens; operators
//                            with low monthly caps must lower this to fit.
//   - model.context_length — total context window cap.
//   - provider_routing     — OpenRouter routing knobs (sort by price, etc.).
//   - providers.<name>     — per-provider timeout / model-specific overrides.

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function readOperatorConfigYaml(seedFrom: string): Record<string, unknown> {
  const path = join(seedFrom, 'config.yaml');
  if (!existsSync(path)) return {};
  try {
    const text = readFileSync(path, 'utf8');
    const parsed = yamlParse(text);
    return isObj(parsed) ? parsed : {};
  } catch {
    // Operator config is unparseable — proceed with Jinn-only. Hermes would
    // also fail to read it, so this isn't hiding any real signal.
    return {};
  }
}

function mergePerTaskConfig(
  operator: Record<string, unknown>,
  jinn: HermesConfigSnippet,
  opts: { model?: string; provider?: string; workingDir: string },
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...operator };

  // model: deep-merge — operator's max_tokens/context_length/base_url/
  // provider_routing/etc. preserved; Jinn overrides default+provider only if
  // specified by daemon/SolverNet config.
  if (opts.model || opts.provider || isObj(out.model)) {
    const opModel = isObj(out.model) ? out.model : {};
    const jinnModel: Record<string, unknown> = {};
    if (opts.model) jinnModel.default = opts.model;
    if (opts.provider) jinnModel.provider = opts.provider;
    out.model = { ...opModel, ...jinnModel };
  }

  // terminal: Jinn forces backend + cwd; operator's timeout / lifetime /
  // sudo_password / docker_* fields preserved (the docker_* fields are inert
  // under `backend: local`, which is fine).
  const opTerminal = isObj(out.terminal) ? out.terminal : {};
  out.terminal = {
    ...opTerminal,
    backend: 'local',
    cwd: opts.workingDir,
  };

  // platform_toolsets: Jinn enforces its allowlist for the `hermes-cli`
  // platform (the platform Jinn spawns Hermes as); other platforms
  // (hermes-telegram, etc.) pass through unchanged.
  const opPlatformToolsets = isObj(out.platform_toolsets) ? out.platform_toolsets : {};
  out.platform_toolsets = {
    ...opPlatformToolsets,
    'hermes-cli': [...TOOLSET_ALLOWLIST],
  };

  // mcp_servers: operator's MCP servers preserved; Jinn adds its SolverPlugin
  // MCP servers via key-merge (Jinn wins on name collision — the SolverPlugin
  // MCP definition is the authority on what `jinn-client` etc. mean).
  if (jinn.mcp_servers && Object.keys(jinn.mcp_servers).length > 0) {
    const opMcp = isObj(out.mcp_servers) ? out.mcp_servers : {};
    out.mcp_servers = { ...opMcp, ...jinn.mcp_servers };
  }

  // skills.external_dirs: operator's dirs preserved; Jinn appends SolverPlugin
  // skill dirs. Duplicates de-duped (preserves order — operator first).
  if (jinn.skills?.external_dirs && jinn.skills.external_dirs.length > 0) {
    const opSkills = isObj(out.skills) ? out.skills : {};
    const opDirs = Array.isArray(opSkills.external_dirs)
      ? (opSkills.external_dirs as unknown[]).filter((d): d is string => typeof d === 'string')
      : [];
    const merged: string[] = [...opDirs];
    for (const d of jinn.skills.external_dirs) {
      if (!merged.includes(d)) merged.push(d);
    }
    out.skills = { ...opSkills, external_dirs: merged };
  }

  return out;
}

function snippetToEnvFile(env: ConfigBuilderEnv): string {
  const lines: string[] = [];
  lines.push(`DAEMON_API_URL=${env.daemonApiUrl}`);
  lines.push(`DAEMON_API_TOKEN=${env.daemonApiToken}`);
  if (env.storePath) lines.push(`STORE_PATH=${env.storePath}`);
  if (env.corpusEnv.subgraphUrl) lines.push(`JINN_CORPUS_SUBGRAPH_URL=${env.corpusEnv.subgraphUrl}`);
  if (env.corpusEnv.ipfsGatewayUrl) lines.push(`JINN_CORPUS_IPFS_GATEWAY_URL=${env.corpusEnv.ipfsGatewayUrl}`);
  if (env.corpusEnv.rpcUrl) lines.push(`JINN_CORPUS_RPC_URL=${env.corpusEnv.rpcUrl}`);
  if (env.corpusEnv.chainId != null) lines.push(`JINN_CORPUS_CHAIN_ID=${env.corpusEnv.chainId}`);
  if (env.corpusEnv.identityRegistryAddress) lines.push(`JINN_CORPUS_IDENTITY_REGISTRY_ADDRESS=${env.corpusEnv.identityRegistryAddress}`);
  if (env.corpusEnv.fromBlock != null) lines.push(`JINN_CORPUS_FROM_BLOCK=${env.corpusEnv.fromBlock}`);
  return lines.join('\n') + '\n';
}

export function writePerTaskHermesConfig(inputs: WritePerTaskConfigInputs): void {
  mkdirSync(inputs.hermesHome, { recursive: true });

  if (inputs.seedFrom) {
    seedOperatorState(inputs.hermesHome, inputs.seedFrom);
  }

  const operator = inputs.seedFrom ? readOperatorConfigYaml(inputs.seedFrom) : {};
  const snippet = hermesConfigFromSolverPlugins(inputs.solverPluginRoots, inputs.env);
  const merged = mergePerTaskConfig(operator, snippet, {
    model: inputs.model,
    provider: inputs.provider,
    workingDir: inputs.workingDir,
  });
  writeFileSync(
    join(inputs.hermesHome, 'config.yaml'),
    yamlStringify(merged, { lineWidth: 0 }),
    'utf8',
  );

  // Per-Task .env = operator's .env (provider API keys, debug toggles, etc.)
  // + Jinn-runtime keys. Jinn keys go LAST so they win on duplicate names
  // (most dotenv loaders use last-wins; Hermes uses python-dotenv). Without
  // the operator's keys, Jinn-run Hermes can't authenticate to any provider
  // except google-gemini-cli (whose OAuth creds are seeded via auth/), so
  // Hermes-as-default with OpenRouter / Anthropic / etc. requires this merge.
  const operatorEnv = inputs.seedFrom ? readOperatorEnvFile(inputs.seedFrom) : '';
  const trailingNewline = operatorEnv.endsWith('\n') ? '' : '\n';
  const header = operatorEnv
    ? `${operatorEnv}${trailingNewline}# --- Jinn-runtime keys (per-Task, override any operator entries above) ---\n`
    : '';
  const envFile = header + snippetToEnvFile(inputs.env);
  writeFileSync(join(inputs.hermesHome, '.env'), envFile, 'utf8');
}

function readOperatorEnvFile(seedFrom: string): string {
  const path = join(seedFrom, '.env');
  if (!existsSync(path)) return '';
  try {
    return readFileSync(path, 'utf8');
  } catch {
    // Permissions / race — better to proceed with just Jinn keys than crash.
    return '';
  }
}
