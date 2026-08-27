/**
 * Runtime credential validity (#1001).
 *
 * Presence (`credentials_resolvable`) and validity are separate readiness
 * facts. This module composes the existing Claude / Hermes / Codex probes —
 * it does not invent a shared credential, and it never echoes secrets.
 *
 * Invalid / malformed authentication is a failing check. The boot gate in
 * `deployment-readiness.ts` makes that fail-loud only for a required runtime
 * in a hosted deployment. Timeout / probe errors stay advisory (fail-safe).
 *
 * That fail-safe split is why every runtime branch must be able to tell a
 * probe that could not run from a probe that ran and said no. A missing or
 * wedged CLI is an infrastructure fault (`error`, advisory); only a credential
 * the runtime actually rejected is `invalid` (blocking, and boot-fatal when
 * hosted).
 */

import {
  CLAUDE_CODE_HARNESS,
  CODEX_HARNESS,
  HERMES_AGENT_HARNESS,
  canonicalHarnessName,
} from '../harnesses/names.js';
import {
  classifyClaudeAuthValidity,
  probeClaudeAuth as defaultProbeClaudeAuth,
  type AuthContext,
  type AuthProbeResult,
  type ProbeOptions,
} from './claude-auth.js';
import {
  probeHermesAuthStatus as defaultProbeHermesAuthStatus,
  type HermesAuthStatus,
  type HermesDoctorConfig,
} from '../api/hermes-doctor-endpoint.js';
import {
  probeCodexDoctor as defaultProbeCodexDoctor,
  type CodexDoctorConfig,
  type CodexDoctorResponse,
} from '../api/codex-doctor-endpoint.js';

export type CredentialRuntime = 'claude' | 'hermes' | 'codex';
export type CredentialValidity = 'valid' | 'absent' | 'invalid' | 'malformed' | 'error';

export interface RuntimeCredentialFact {
  runtime: CredentialRuntime;
  validity: CredentialValidity;
  /**
   * Why an `error` verdict happened, when we know: `timed out`, or the spawn
   * errno (`ENOENT`, `EACCES`, `ETIMEDOUT`). Diagnostic only, never secret
   * material — it names the tool that failed, not the credential.
   */
  note?: string;
}

export interface CredentialValidityCheckResult {
  name: 'credentials_valid';
  ok: boolean;
  detail: string;
  remedy?: string;
  runtimes: RuntimeCredentialFact[];
}

export interface CheckCredentialsValidInput {
  requiredRuntimes: readonly CredentialRuntime[];
  env: NodeJS.ProcessEnv;
  /** Auth context for the Claude probe (container / docker-compose / bare). */
  authContext: AuthContext;
  claudePath?: string;
  hermesPath?: string;
  hermesProvider?: string;
  codexPath?: string;
}

export interface CheckCredentialsValidDeps {
  probeClaudeAuth: (opts: ProbeOptions) => AuthProbeResult | Promise<AuthProbeResult>;
  probeHermesAuthStatus: (
    provider: string,
    config?: HermesDoctorConfig,
  ) => Promise<HermesAuthStatus>;
  probeCodexDoctor: (
    config?: CodexDoctorConfig,
  ) => Promise<Pick<CodexDoctorResponse, 'authStatus' | 'installed' | 'exitCode' | 'authenticated'>>;
  validityTimeoutMs?: number;
}

export const DEFAULT_CREDENTIAL_VALIDITY_TIMEOUT_MS = 10_000;

const CLAUDE_ENV_KEYS = ['ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN'] as const;
const HERMES_ENV_KEYS = ['OPENROUTER_API_KEY'] as const;
const RUNTIME_ORDER: readonly CredentialRuntime[] = ['claude', 'hermes', 'codex'];

const REMEDY: Record<CredentialRuntime, string> = {
  claude:
    'Provide a valid ANTHROPIC_API_KEY or CLAUDE_CODE_OAUTH_TOKEN secret, or re-authenticate the Claude CLI.',
  hermes:
    'Provide a valid OPENROUTER_API_KEY secret, or reconnect OpenRouter (`hermes login`).',
  codex:
    'Provide a valid OPENAI_API_KEY secret, or run `codex login` to refresh the session.',
};

export function requiredCredentialRuntimes(
  executionWiring: ReadonlyArray<{ harness: string }> | undefined,
): CredentialRuntime[] {
  const found = new Set<CredentialRuntime>();
  for (const entry of executionWiring ?? []) {
    const runtime = runtimeFromHarness(entry.harness);
    if (runtime) found.add(runtime);
  }
  return RUNTIME_ORDER.filter((runtime) => found.has(runtime));
}

export function productionCredentialValidityDeps(): CheckCredentialsValidDeps {
  return {
    probeClaudeAuth: defaultProbeClaudeAuth,
    probeHermesAuthStatus: defaultProbeHermesAuthStatus,
    probeCodexDoctor: defaultProbeCodexDoctor,
  };
}

export async function checkCredentialsValid(
  input: CheckCredentialsValidInput,
  deps: CheckCredentialsValidDeps,
): Promise<CredentialValidityCheckResult> {
  if (input.requiredRuntimes.length === 0) {
    return {
      name: 'credentials_valid',
      ok: true,
      detail: 'no required runtime configured — validity not evaluated',
      runtimes: [],
    };
  }

  const timeoutMs = deps.validityTimeoutMs ?? DEFAULT_CREDENTIAL_VALIDITY_TIMEOUT_MS;
  const facts: RuntimeCredentialFact[] = [];

  for (const runtime of input.requiredRuntimes) {
    const probed = await probeRuntime(runtime, input, deps, timeoutMs);
    facts.push({
      runtime,
      validity: probed.validity,
      ...(probed.note !== undefined ? { note: probed.note } : {}),
    });
  }

  const blocking = facts.filter((fact) => fact.validity === 'invalid' || fact.validity === 'malformed');
  const detail = facts
    .map((fact) =>
      fact.note !== undefined
        ? `${fact.runtime}: ${fact.validity} (${fact.note})`
        : `${fact.runtime}: ${fact.validity}`,
    )
    .join('; ');

  return {
    name: 'credentials_valid',
    ok: blocking.length === 0,
    detail,
    ...(blocking.length > 0
      ? { remedy: blocking.map((fact) => `${fact.runtime}: ${REMEDY[fact.runtime]}`).join(' ') }
      : {}),
    runtimes: facts,
  };
}

function runtimeFromHarness(harness: string): CredentialRuntime | null {
  const name = canonicalHarnessName(harness);
  if (name === CLAUDE_CODE_HARNESS) return 'claude';
  if (name === HERMES_AGENT_HARNESS) return 'hermes';
  if (name === CODEX_HARNESS) return 'codex';
  if (name.startsWith('claude-') || name === 'legacy-claude') return 'claude';
  return null;
}

function envPresent(env: NodeJS.ProcessEnv, keys: readonly string[]): boolean {
  return keys.some((key) => {
    const value = env[key];
    return typeof value === 'string' && value.trim().length > 0;
  });
}

async function probeRuntime(
  runtime: CredentialRuntime,
  input: CheckCredentialsValidInput,
  deps: CheckCredentialsValidDeps,
  timeoutMs: number,
): Promise<ProbeOutcome> {
  try {
    const raced = await withTimeout(runProbe(runtime, input, deps), timeoutMs);
    if (!raced.ok) return { validity: 'error', note: 'timed out' };
    return raced.value;
  } catch {
    return { validity: 'error' };
  }
}

interface ProbeOutcome {
  validity: CredentialValidity;
  note?: string;
}

async function runProbe(
  runtime: CredentialRuntime,
  input: CheckCredentialsValidInput,
  deps: CheckCredentialsValidDeps,
): Promise<ProbeOutcome> {
  switch (runtime) {
    case 'claude': {
      const probe = await deps.probeClaudeAuth({
        context: input.authContext,
        cwd: process.cwd(),
        ...(input.claudePath !== undefined ? { claudePath: input.claudePath } : {}),
      });
      const classified = classifyClaudeAuthValidity(probe);
      if (classified === 'valid' || classified === 'malformed' || classified === 'error') {
        return { validity: classified };
      }
      return { validity: envPresent(input.env, CLAUDE_ENV_KEYS) ? 'invalid' : 'absent' };
    }
    case 'hermes': {
      const provider = input.hermesProvider?.trim() || 'openrouter';
      const config: HermesDoctorConfig = {};
      if (input.hermesPath !== undefined) config.hermesPath = input.hermesPath;
      const probe = await deps.probeHermesAuthStatus(provider, config);
      // A probe that could not run at all is an infrastructure fault, not a
      // credential verdict. `probeHermesAuthStatus` resolves normally for a
      // missing / wedged binary, so without this branch a hermes that is
      // absent from the image reads as `invalid` — which is boot-fatal for a
      // required runtime in a hosted deployment, taking the operator console
      // down with it. Claude and Codex both carve this case out already.
      if (probe.errorCode !== undefined) {
        return { validity: 'error', note: probe.errorCode };
      }
      if (probe.authed) return { validity: 'valid' };
      return { validity: envPresent(input.env, HERMES_ENV_KEYS) ? 'invalid' : 'absent' };
    }
    case 'codex': {
      const config: CodexDoctorConfig = { env: input.env };
      if (input.codexPath !== undefined) config.codexPath = input.codexPath;
      const probe = await deps.probeCodexDoctor(config);
      if (!probe.installed) return { validity: 'error', note: 'codex CLI not installed' };
      if (probe.exitCode !== 0) return { validity: 'error', note: 'codex CLI probe failed' };
      if (probe.authStatus === 'ok') return { validity: 'valid' };
      if (probe.authStatus === 'not_configured') return { validity: 'absent' };
      return { validity: 'invalid' };
    }
  }
}

async function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
): Promise<{ ok: true; value: T } | { ok: false }> {
  let handle: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise.then((value) => ({ ok: true as const, value })),
      new Promise<{ ok: false }>((resolve) => {
        handle = setTimeout(() => resolve({ ok: false }), ms);
      }),
    ]);
  } finally {
    if (handle !== undefined) clearTimeout(handle);
  }
}
