/**
 * Deployment-readiness preflight (issue #958).
 *
 * Hosted deploys have no boot-time guard that the environment is fit to run;
 * misconfig fails silently or mid-run. This module adds a set of checks that
 * answer "is this environment fit to run the daemon?" and a boot gate that
 * **fails loud — but only in a deployment context**.
 *
 * Load-bearing constraint: a plain local `jinn run` (no `JINN_STATE_DIR`,
 * running as the user) must NEVER be newly gated. The
 * fail-loud boot gate fires only when `isDeploymentContext()` is true; outside
 * that, every check is advisory (surfaced in `doctor`, never boot-fatal). The
 * `doctor` command runs all checks regardless of context.
 *
 * The checks compose existing primitives where possible:
 *   - `writable_volume`        — the one genuinely new primitive (write+fsync+unlink probe)
 *   - `state_on_volume`        — assert resolved state lives on the configured volume
 *   - `credentials_resolvable` — reuses `detectAuthContext`; presence-only, NEVER echoes secrets
 *   - `credentials_valid`      — runtime-specific Claude / Hermes / Codex probes (#1001)
 *   - `agent_cli_non_root`     — uid 0 is unfit (the agent CLI refuses to run as root)
 *
 * Every check is side-effect-light and NEVER throws — a failure becomes a
 * structured fail result, not an exception. The aggregate is the safe caller
 * surface; the gate adds the fail-loud envelope on top.
 */

import { promises as fs } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';

import { emitEnvelope, type EnvelopeSinks } from '../errors/envelope.js';
import { emitStructured } from '../events/emitter.js';
import {
  detectAuthContext as defaultDetectAuthContext,
  type AuthContext,
  type AuthProbeResult,
  type ProbeOptions,
} from './claude-auth.js';
import {
  checkCredentialsValid,
  productionCredentialValidityDeps,
  requiredCredentialRuntimes,
  type CheckCredentialsValidDeps,
  type RuntimeCredentialFact,
} from './credential-validity.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface DeploymentCheckResult {
  name:
    | 'writable_volume'
    | 'state_on_volume'
    | 'credentials_resolvable'
    | 'credentials_valid'
    | 'agent_cli_non_root';
  ok: boolean;
  detail: string;
  remedy?: string;
  /** `credentials_valid` only — per-runtime classification, never secret material. */
  runtimes?: RuntimeCredentialFact[];
}

/** Inputs that come from the resolved config / process — never secret values. */
export interface DeploymentReadinessInputs {
  /** `config.stateDir` — the volume root, when set (S3, JINN_STATE_DIR). */
  stateDir: string | undefined;
  /** `config.earningDir` — the resolved earning/state directory. */
  earningDir: string;
  /**
   * `config.runtimeMode` — a persisted runtime mode (`'docker-compose'` /
   * `'container'`) declared by the operator (via `jinn auth --mode` or the app
   * setup) rather than via env / `/.dockerenv`. Threaded into
   * `detectAuthContext` as `configuredMode` so a config-declared compose /
   * container operator is detected as a deployment context (and the boot gate
   * arms) even with no `JINN_RUNTIME_MODE` env var and no `/.dockerenv`.
   * `undefined` leaves detection on env / filesystem signals only — preserving
   * the bare-local regression guarantee.
   */
  runtimeMode: AuthContext | undefined;
  /**
   * Configured participation wiring. Harness names here are the required
   * runtimes for `credentials_valid`. Empty / omitted means no runtime is
   * required, so invalid auth cannot be boot-fatal.
   */
  executionWiring?: ReadonlyArray<{ harness: string }>;
  claudePath?: string;
  hermesPath?: string;
  hermesProvider?: string;
  codexPath?: string;
}

/** Injectable dependencies — tests pass doubles; production uses the defaults. */
export interface DeploymentReadinessDeps {
  env: NodeJS.ProcessEnv;
  /** `process.getuid` (undefined on platforms without it, e.g. Windows). */
  getuid: (() => number) | undefined;
  detectAuthContext: typeof defaultDetectAuthContext;
  probeClaudeAuth?: (opts: ProbeOptions) => AuthProbeResult | Promise<AuthProbeResult>;
  probeHermesAuthStatus?: CheckCredentialsValidDeps['probeHermesAuthStatus'];
  probeCodexDoctor?: CheckCredentialsValidDeps['probeCodexDoctor'];
  validityTimeoutMs?: number;
}

export interface DeploymentReadinessReport {
  /** True when we are in a deployment context (gate is armed). */
  deployment: boolean;
  /** The auth context detected for this run. */
  authContext: AuthContext;
  checks: DeploymentCheckResult[];
  /**
   * True when the daemon must refuse to boot: deployment context AND at least
   * one HARD check failed. Always false outside a deployment context.
   */
  bootFatal: boolean;
}

/** Hard checks — failing one of these in a deployment context refuses the boot. */
const HARD_CHECK_NAMES: ReadonlySet<DeploymentCheckResult['name']> = new Set([
  'writable_volume',
  'state_on_volume',
  'agent_cli_non_root',
  'credentials_valid',
]);

// ---------------------------------------------------------------------------
// isDeploymentContext
// ---------------------------------------------------------------------------

/**
 * Deployment context = `JINN_STATE_DIR` set OR `config.stateDir` set OR the
 * auth context is a container / docker-compose. A plain local operator (bare
 * context, no state-dir) is NOT a deployment context, so the boot gate stays
 * disarmed for them.
 */
export function isDeploymentContext(input: {
  env: NodeJS.ProcessEnv;
  authContext: AuthContext;
  stateDir: string | undefined;
}): boolean {
  if (typeof input.env['JINN_STATE_DIR'] === 'string' && input.env['JINN_STATE_DIR'].length > 0) {
    return true;
  }
  if (typeof input.stateDir === 'string' && input.stateDir.length > 0) return true;
  return input.authContext === 'container' || input.authContext === 'docker-compose';
}

// ---------------------------------------------------------------------------
// writable_volume — the new primitive
// ---------------------------------------------------------------------------

/**
 * Attempt to write + fsync + unlink a temp file under `dir`. ok when it
 * succeeds; structured fail (never throws) on EACCES / EROFS / ENOSPC / missing
 * dir / any other fs error.
 */
export async function checkWritableVolume(dir: string): Promise<DeploymentCheckResult> {
  const probePath = join(dir, `.jinn-writeprobe-${process.pid}-${randomBytes(4).toString('hex')}`);
  let handle: fs.FileHandle | undefined;
  try {
    handle = await fs.open(probePath, 'w', 0o600);
    await handle.write('jinn-writable-volume-probe');
    await handle.sync();
    await handle.close();
    handle = undefined;
    await fs.unlink(probePath);
    return {
      name: 'writable_volume',
      ok: true,
      detail: `${dir} is writable`,
    };
  } catch (err) {
    // Best-effort cleanup; ignore whatever it throws.
    if (handle) await handle.close().catch(() => undefined);
    await fs.unlink(probePath).catch(() => undefined);
    const code = (err as NodeJS.ErrnoException).code;
    return {
      name: 'writable_volume',
      ok: false,
      detail: `${dir} is not writable${code ? ` (${code})` : ''}`,
      remedy:
        'Ensure the daemon process can write to the state directory. In hosted deploys, mount a writable ' +
        'persistent volume at the path pointed to by JINN_STATE_DIR (or earningDir) and give the daemon user write access.',
    };
  }
}

// ---------------------------------------------------------------------------
// state_on_volume
// ---------------------------------------------------------------------------

/**
 * In a deployment context, assert resolved state lives on the configured
 * volume — i.e. `stateDir` is set AND `earningDir` resolves under it. Advisory
 * (always ok) outside a deployment context.
 */
export function checkStateOnVolume(input: {
  deployment: boolean;
  stateDir: string | undefined;
  earningDir: string;
}): DeploymentCheckResult {
  if (!input.deployment) {
    return {
      name: 'state_on_volume',
      ok: true,
      detail: 'not a deployment context — state location is advisory only',
    };
  }
  if (!input.stateDir) {
    return {
      name: 'state_on_volume',
      ok: false,
      detail:
        'deployment context but JINN_STATE_DIR / stateDir is unset — state would land on the ephemeral ~/.jinn-client default and be lost on redeploy',
      remedy: 'Set JINN_STATE_DIR to the mounted persistent volume (e.g. JINN_STATE_DIR=/data).',
    };
  }
  const root = resolve(input.stateDir);
  const earning = resolve(input.earningDir);
  const under = earning === root || earning.startsWith(root + '/');
  if (!under) {
    return {
      name: 'state_on_volume',
      ok: false,
      detail: `earningDir (${earning}) does not resolve under the configured volume (${root})`,
      remedy:
        'Remove the per-key earningDir/dbPath override so state derives under JINN_STATE_DIR, or point them at the volume.',
    };
  }
  return {
    name: 'state_on_volume',
    ok: true,
    detail: `state resolves under the configured volume ${root}`,
  };
}

// ---------------------------------------------------------------------------
// credentials_resolvable
// ---------------------------------------------------------------------------

/**
 * Presence-only credential check. In a bare context the operator authenticates
 * the agent CLI interactively (claude session auth), so credentials are not
 * env-resolvable and that is fine. In a container / compose context there is no
 * interactive login, so SOME agent-CLI auth signal must be present in the env.
 *
 * NEVER returns or logs a secret value — only presence + context.
 */
export function checkCredentialsResolvable(input: {
  context: AuthContext;
  env: NodeJS.ProcessEnv;
}): DeploymentCheckResult {
  // Env vars that, if present and non-empty, indicate the agent CLI can resolve
  // credentials non-interactively. Presence only — values are never read out.
  const AUTH_ENV_KEYS = [
    'ANTHROPIC_API_KEY',
    'CLAUDE_CODE_OAUTH_TOKEN',
    'OPENROUTER_API_KEY',
    'OPENAI_API_KEY',
  ] as const;
  const present = AUTH_ENV_KEYS.filter((k) => {
    const v = input.env[k];
    return typeof v === 'string' && v.trim().length > 0;
  });

  if (input.context === 'bare') {
    return {
      name: 'credentials_resolvable',
      ok: true,
      detail:
        present.length > 0
          ? `bare context; agent-CLI auth env present (${present.length} key(s))`
          : 'bare context; agent CLI uses interactive session auth',
    };
  }

  // container / docker-compose: no interactive login path — need an env signal.
  if (present.length > 0) {
    return {
      name: 'credentials_resolvable',
      ok: true,
      detail: `${input.context} context; agent-CLI auth env present (${present.length} key(s))`,
    };
  }
  return {
    name: 'credentials_resolvable',
    ok: false,
    detail: `${input.context} context but no agent-CLI auth credential is resolvable from the environment`,
    remedy:
      'Provide the agent CLI credentials the harness needs (e.g. ANTHROPIC_API_KEY / CLAUDE_CODE_OAUTH_TOKEN, ' +
      'or OPENROUTER_API_KEY for the hermes harness) as a secret in the deploy environment.',
  };
}

// ---------------------------------------------------------------------------
// agent_cli_non_root
// ---------------------------------------------------------------------------

/**
 * ok when uid !== 0 (or no getuid on the platform). Fail when running as root —
 * the agent CLI refuses to run as root, so a root daemon is unfit. Never throws.
 */
export function checkAgentCliNonRoot(getuid: (() => number) | undefined): DeploymentCheckResult {
  if (typeof getuid !== 'function') {
    return {
      name: 'agent_cli_non_root',
      ok: true,
      detail: 'platform has no uid concept — non-root assumption holds',
    };
  }
  let uid: number;
  try {
    uid = getuid();
  } catch {
    // Can't determine uid: don't crash, treat as non-fatal (conservative ok —
    // we'd rather not falsely gate a boot on an unreadable uid).
    return {
      name: 'agent_cli_non_root',
      ok: true,
      detail: 'could not read process uid — assuming non-root',
    };
  }
  if (uid === 0) {
    return {
      name: 'agent_cli_non_root',
      ok: false,
      detail: 'daemon is running as root (uid 0); the agent CLI refuses to run as root',
      remedy:
        'Run the daemon as a non-root user. In containers, create and drop to a non-root user (e.g. via gosu) before launching.',
    };
  }
  return {
    name: 'agent_cli_non_root',
    ok: true,
    detail: `running as non-root (uid ${uid})`,
  };
}

// ---------------------------------------------------------------------------
// runDeploymentReadinessChecks — the aggregate
// ---------------------------------------------------------------------------

/**
 * Run every deployment-readiness check and assemble a report. Detects the
 * deployment context internally and decides `bootFatal` accordingly. Never
 * throws — each check degrades to a structured fail.
 */
export async function runDeploymentReadinessChecks(
  inputs: DeploymentReadinessInputs,
  deps: DeploymentReadinessDeps,
): Promise<DeploymentReadinessReport> {
  const authContext = (() => {
    try {
      return deps.detectAuthContext({
        cwd: process.cwd(),
        env: deps.env,
        configuredMode: inputs.runtimeMode,
      });
    } catch {
      return 'bare' as AuthContext;
    }
  })();

  const deployment = isDeploymentContext({
    env: deps.env,
    authContext,
    stateDir: inputs.stateDir,
  });

  // The writable-volume probe targets the volume root when set, else earningDir.
  const probeDir = inputs.stateDir ?? inputs.earningDir;

  const productionValidity = productionCredentialValidityDeps();
  const validityDeps: CheckCredentialsValidDeps = {
    probeClaudeAuth: deps.probeClaudeAuth ?? productionValidity.probeClaudeAuth,
    probeHermesAuthStatus: deps.probeHermesAuthStatus ?? productionValidity.probeHermesAuthStatus,
    probeCodexDoctor: deps.probeCodexDoctor ?? productionValidity.probeCodexDoctor,
    ...(deps.validityTimeoutMs !== undefined ? { validityTimeoutMs: deps.validityTimeoutMs } : {}),
  };

  const checks: DeploymentCheckResult[] = [
    await checkWritableVolume(probeDir),
    checkStateOnVolume({ deployment, stateDir: inputs.stateDir, earningDir: inputs.earningDir }),
    checkCredentialsResolvable({ context: authContext, env: deps.env }),
    await checkCredentialsValid(
      {
        requiredRuntimes: requiredCredentialRuntimes(inputs.executionWiring),
        env: deps.env,
        ...(inputs.claudePath !== undefined ? { claudePath: inputs.claudePath } : {}),
        ...(inputs.hermesPath !== undefined ? { hermesPath: inputs.hermesPath } : {}),
        ...(inputs.hermesProvider !== undefined ? { hermesProvider: inputs.hermesProvider } : {}),
        ...(inputs.codexPath !== undefined ? { codexPath: inputs.codexPath } : {}),
      },
      validityDeps,
    ),
    checkAgentCliNonRoot(deps.getuid),
  ];

  const bootFatal =
    deployment && checks.some((c) => !c.ok && HARD_CHECK_NAMES.has(c.name));

  return { deployment, authContext, checks, bootFatal };
}

// ---------------------------------------------------------------------------
// applyDeploymentReadinessGate — the boot gate (fail-loud only in deployment)
// ---------------------------------------------------------------------------

/**
 * Boot gate for `jinn run`. Runs the readiness aggregate; in a deployment
 * context, fail loud (emit `invalid_invocation` envelope + non-zero exit) when
 * a hard check fails. Outside a deployment context, log advisories for any
 * failing check and proceed. Mirrors `applyPidfileLivenessGate`'s contract:
 * `emitEnvelope` does not return in production (it `process.exit`s).
 */
export async function applyDeploymentReadinessGate(
  inputs: DeploymentReadinessInputs,
  deps: DeploymentReadinessDeps,
  sinks: EnvelopeSinks = {},
): Promise<void> {
  const report = await runDeploymentReadinessChecks(inputs, deps);
  const failed = report.checks.filter((c) => !c.ok);

  if (report.bootFatal) {
    const hardFailures = failed.filter((c) => HARD_CHECK_NAMES.has(c.name));
    const summary = hardFailures.map((c) => `${c.name}: ${c.detail}`).join('; ');
    emitEnvelope(
      {
        code: 'invalid_invocation',
        message: `Environment is not fit to run the daemon in this deployment — ${summary}`,
        hint: 'Run `jinn doctor --human` for the full readiness report. Fix the failing check(s) and restart.',
        exampleCli: 'jinn doctor --human',
        details: {
          field: 'deployment_readiness',
          authContext: report.authContext,
          // Names + ok only — no secret material, no raw env values.
          failed: hardFailures.map((c) => ({ name: c.name, detail: c.detail })),
        },
      },
      sinks,
    );
    // emitEnvelope calls process.exit in production; in tests the injected exit
    // is a no-op. Either way, do not fall through to "proceed" logging.
    return;
  }

  // Advisory path (local operator, or non-hard failures in a deployment ctx):
  // surface each failing check but never gate the boot.
  for (const c of failed) {
    emitStructured({
      kind: 'system',
      message: `deployment-readiness advisory — ${c.name}: ${c.detail}`,
      details: {
        phase: 'preflight',
        check: c.name,
        deployment: report.deployment,
        ...(c.remedy ? { remedy: c.remedy } : {}),
      },
    });
  }
}
