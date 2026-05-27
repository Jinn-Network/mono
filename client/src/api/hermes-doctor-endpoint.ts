/**
 * GET /api/hermes/doctor
 *
 * Runs `hermes doctor` via async execFile and returns the result so the
 * operator dashboard can show an install-required panel before the operator
 * saves a Hermes Agent harness selection.
 *
 * Response shape:
 *   { installed: boolean, exitCode: number | null, stdout: string, stderr: string }
 *
 * `installed: false` means the binary was not found (ENOENT or equivalent).
 * `exitCode !== 0` (with `installed: true`) means the binary exists but
 * reports a config problem.
 *
 * The probe logic is exported as `probeHermesDoctor` so the Hermes harness
 * can reuse it from `isReady()` — same source of truth for the SPA
 * precheck panel and the daemon's claim-readiness gate (#330).
 *
 * Async (#778 follow-up): the readiness registry refreshes Hermes isReady()
 * periodically. Before this conversion both `hermes doctor` and `hermes auth
 * list openrouter` ran via `spawnSync`, blocking the main event loop for the
 * duration of each shell-out. Live observation: ~2 sync spawns/sec keeping
 * ~99% main-thread sample time in `node::SyncProcessRunner::Spawn`. Same
 * wedge class as the harvest/restoration-patch fix in #778 — converted to
 * `promisify(execFile)` with a 10s timeout per call.
 */
import type { Hono } from 'hono';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export interface HermesDoctorResponse {
  installed: boolean;
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

export interface HermesDoctorConfig {
  hermesPath?: string;
  hermesDoctorTimeoutMs?: number;
}

/** Internal result shape mirroring the subset of SpawnSyncReturns the probes use. */
interface HermesRunResult {
  status: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}

/**
 * Shared `hermes <args>` spawn scaffolding for both probes: resolves the binary
 * and timeout from config, runs async `execFile`, and extracts the spawn-error
 * code. Each probe applies its own classification/parsing to the returned
 * result.
 *
 * Async (#778 follow-up): previously `spawnSync` — see file header. A non-zero
 * exit OR a kill-by-timeout surfaces here as a thrown `child_process` error
 * whose payload carries `stdout`, `stderr`, `code`, `signal`, and `killed`. We
 * unwrap that into the same `{status, signal, stdout, stderr}` shape the old
 * sync code returned so callers don't have to special-case throw vs exit.
 */
async function runHermes(
  args: string[],
  config: HermesDoctorConfig,
): Promise<{ result: HermesRunResult; errorCode: string | undefined }> {
  const hermesBin = config.hermesPath ?? 'hermes';
  // Default 10s here (vs 30s on the sync path) because these probes fire every
  // readiness-registry tick. A truly stuck shell-out must not snowball into a
  // per-tick 30s timer outstanding.
  const timeoutMs = config.hermesDoctorTimeoutMs ?? 10_000;

  try {
    const { stdout, stderr } = await execFileAsync(hermesBin, args, {
      timeout: timeoutMs,
      encoding: 'utf8',
    });
    return {
      result: { status: 0, signal: null, stdout, stderr },
      errorCode: undefined,
    };
  } catch (err) {
    const errno = err as NodeJS.ErrnoException & {
      stdout?: string | Buffer;
      stderr?: string | Buffer;
      code?: number | string;
      signal?: NodeJS.Signals;
      killed?: boolean;
    };
    // `code` is either a numeric exit code (process ran and exited non-zero)
    // OR a string errno like `ENOENT` (spawn failed entirely). Disambiguate
    // so the classification logic in probeHermesDoctor matches the sync
    // semantics it always had.
    const codeIsString = typeof errno.code === 'string';
    const numericStatus = !codeIsString && typeof errno.code === 'number' ? errno.code : null;
    const errorCode = codeIsString ? (errno.code as string) : undefined;
    const stdout = typeof errno.stdout === 'string' ? errno.stdout : errno.stdout?.toString() ?? '';
    const stderr = typeof errno.stderr === 'string' ? errno.stderr : errno.stderr?.toString() ?? '';
    return {
      result: {
        status: numericStatus,
        signal: errno.signal ?? null,
        stdout,
        stderr,
      },
      errorCode,
    };
  }
}

/**
 * Asynchronously runs `hermes doctor` and classifies the result. Pure (no
 * Hono dependency) so the harness layer can call it without pulling the API
 * server in.
 */
export async function probeHermesDoctor(config: HermesDoctorConfig = {}): Promise<HermesDoctorResponse> {
  const { result, errorCode } = await runHermes(['doctor'], config);

  // installed=true means we found the binary on disk. ENOENT is the only
  // definitive not-installed signal. Other errors (EACCES = wrong
  // permissions; ETIMEDOUT = ran but didn't finish in time) indicate the
  // binary exists but couldn't be exercised cleanly — surface those as
  // config-issue, not missing.
  const notFound = errorCode === 'ENOENT';
  const installed = !notFound && (
    result.status !== null
    || result.signal !== null
    || (errorCode != null && errorCode !== 'ENOENT')
  );
  return {
    installed,
    exitCode: result.status,
    stdout: (result.stdout ?? '').slice(0, 4000),
    stderr: (result.stderr ?? '').slice(0, 4000),
  };
}

/**
 * Result of probing a single Hermes model provider's auth state.
 */
export interface HermesAuthStatus {
  /** Provider name probed, e.g. `openrouter`. */
  provider: string;
  /** True only when the provider has a usable credential. */
  authed: boolean;
  /** Raw `hermes auth list <provider>` stdout (trimmed, truncated). */
  raw: string;
}

/**
 * Detects whether a single `hermes auth list` credential line is currently
 * *unusable* — i.e. the credential pool has flagged it exhausted with retry
 * time still on the clock, or marked it as a hard auth failure.
 *
 * `hermes auth list` annotates exhausted entries via
 * `_format_exhausted_status` (hermes_cli/auth_commands.py). The annotation
 * forms we treat as still-usable:
 *   - no annotation at all          → healthy credential
 *   - `... (ready to retry)`        → exhaustion window has elapsed; usable
 * The forms we treat as unusable:
 *   - `... rate-limited ... (12m 3s left)` / `... exhausted ... (1h 4m left)`
 *   - `... auth failed ... (re-auth may be required)`
 *
 * A line that carries an exhaustion keyword but no `(ready to retry)` and no
 * `re-auth` hint (e.g. exhausted with a wait window still open) is unusable.
 */
function isCredentialLineUnusable(line: string): boolean {
  // `(ready to retry)` means the exhaustion window has elapsed — usable.
  if (/\(ready to retry\)/i.test(line)) return false;
  // A hard auth failure or any still-open exhaustion window → unusable.
  return /\bauth failed\b|\(re-auth may be required\)|\brate-limited\b|\bexhausted\b/i.test(line);
}

/**
 * Asynchronously runs `hermes auth list <provider>` and classifies whether the
 * provider has a usable credential (API-key OR OAuth) in Hermes's credential
 * pool.
 *
 * WHY `auth list`, not `auth status`: `hermes auth status <provider>` only
 * reflects interactive-OAuth-login state (the `providers` block in
 * `~/.hermes/auth.json`). It prints `<provider>: logged out` whenever there
 * is no OAuth session — even when an API-key credential is present and
 * working. An operator who authenticated to OpenRouter the normal way
 * (`OPENROUTER_API_KEY` env var, or `hermes auth add`) would be wrongly
 * reported not-ready and gated out of every claim. `hermes auth list` reads
 * the `credential_pool`, so it sees api_key credentials too.
 *
 * Parsing (`auth list <provider>` output, see `auth_list_command` in
 * hermes_cli/auth_commands.py):
 *   - empty stdout → no credential of any kind → not authed
 *   - a `<provider> (N credentials):` header followed by `  #<idx> ...` lines,
 *     one per pooled credential → authed iff at least one line is *usable*
 *     (not exhausted with a wait window still open, not a hard auth failure)
 *   - ENOENT / spawn error → not authed (binary not on PATH)
 *
 * `hermes auth list` exits 0 in all of these cases; the signal is entirely in
 * stdout. Pure (no Hono dependency) so the harness layer can call it without
 * pulling the API server in. This is the third readiness gate for Hermes:
 * `hermes doctor` exits 0 even when every provider is logged out (it treats
 * missing providers as warnings), so the harness must probe auth directly.
 */
export async function probeHermesAuthStatus(
  provider: string,
  config: HermesDoctorConfig = {},
): Promise<HermesAuthStatus> {
  const { result, errorCode } = await runHermes(['auth', 'list', provider], config);
  const raw = (result.stdout ?? '').trim().slice(0, 4000);

  // Binary not found, or any other spawn error, or no output → not authed.
  // Empty stdout means `auth_list_command` skipped the provider section
  // because the credential pool has zero entries for it.
  if (errorCode != null || raw.length === 0) {
    return { provider, authed: false, raw };
  }

  // Credential lines are the `  #<idx> ...` rows under the provider header.
  // A provider is usable when at least one of its pooled credentials is not
  // currently exhausted / hard-failed.
  const credentialLines = raw
    .split('\n')
    .filter((line) => /^\s*#\d+\b/.test(line));
  if (credentialLines.length === 0) {
    // Header present but no credential rows parsed — treat as not authed
    // rather than guess.
    return { provider, authed: false, raw };
  }
  const hasUsableCredential = credentialLines.some(
    (line) => !isCredentialLineUnusable(line),
  );
  return { provider, authed: hasUsableCredential, raw };
}

export function addHermesDoctorRoutes(app: Hono, config: HermesDoctorConfig = {}): void {
  app.get('/api/hermes/doctor', async (c) => {
    return c.json(await probeHermesDoctor(config));
  });
}

/**
 * Result of probing OpenRouter's `/api/v1/key` endpoint for spendable credit.
 *
 * `state` is the verdict we feed into readiness:
 *   - `ok`        → remaining credit is at or above the floor → ready
 *   - `exhausted` → remaining credit is below the floor → NOT ready (clear
 *                   actionable signal: operator must top up)
 *   - `unknown`   → couldn't determine — network error, non-200, malformed
 *                   JSON, missing API key. Readiness MUST treat this as
 *                   fail-safe (ready=true) so a transient OpenRouter outage
 *                   does not shut every operator down (#332 / production
 *                   bug 2026-05-23: false-positive ready when credit
 *                   exhausted, but we explicitly do NOT want the inverse
 *                   false-negative).
 *
 * `remainingUsd` and `floorUsd` are populated when known (state=`ok` or
 * `exhausted`) so the readiness `nextStep` can show the operator how short
 * they are. `raw` carries the truncated response body for diagnostics.
 */
export interface OpenRouterCreditStatus {
  state: 'ok' | 'exhausted' | 'unknown';
  remainingUsd?: number;
  limitUsd?: number | null;
  usageUsd?: number;
  floorUsd: number;
  reason?: string;
  raw?: string;
}

export interface OpenRouterCreditConfig {
  /**
   * Per-task credit floor in USD. The default is generous enough to cover a
   * single SWE-rebench solve with `max_tokens=32000` against the priciest
   * frontier models at typical 2026 OpenRouter rates ($3-$5 / Mtok output =
   * $0.10-$0.16 per solve), with headroom for input-token cost and the
   * occasional retry. Tune via the env override below if a SolverNet pins
   * a different model class.
   */
  floorUsd?: number;
  /** Override the OpenRouter API key (defaults to `process.env.OPENROUTER_API_KEY`). */
  apiKey?: string;
  /** Inject a custom fetch for tests; defaults to global `fetch`. */
  fetchFn?: typeof fetch;
  /** HTTP timeout in ms. Defaults to 5s — readiness probes must not stall the daemon. */
  timeoutMs?: number;
}

/**
 * Default per-task credit floor (USD). See {@link OpenRouterCreditConfig}.
 *
 * Sized to comfortably cover one solve on a cheap routed model (e.g.
 * `deepseek/deepseek-v4-flash` — typical solve costs ~$0.01-0.02 with the
 * `JINN_HERMES_MAX_TOKENS_CAP` of 32000). An operator using a premium model
 * (Sonnet, GPT-5) should override via the `JINN_HERMES_CREDIT_FLOOR_USD`
 * env var (or pass `floorUsd` explicitly).
 *
 * History: a too-conservative initial default of $0.50 — sized for Sonnet —
 * silently gated out deepseek operators with $0.43 remaining (enough for
 * ~25 solves) on 2026-05-23. The right size is the cost of *one* task with
 * comfortable headroom, not a Sonnet-class reserve.
 */
const DEFAULT_OPENROUTER_CREDIT_FLOOR_USD_FALLBACK = 0.02;
const envFloor = process.env['JINN_HERMES_CREDIT_FLOOR_USD'];
const envFloorParsed = envFloor !== undefined ? Number(envFloor) : NaN;
export const DEFAULT_OPENROUTER_CREDIT_FLOOR_USD =
  Number.isFinite(envFloorParsed) && envFloorParsed > 0
    ? envFloorParsed
    : DEFAULT_OPENROUTER_CREDIT_FLOOR_USD_FALLBACK;

/**
 * Probes `GET https://openrouter.ai/api/v1/key` to determine whether the
 * operator's OpenRouter credential has spendable credit above the per-task
 * floor.
 *
 * WHY this gate exists (production bug, 2026-05-23): the existing readiness
 * gates — `hermes doctor` + `hermes auth list openrouter` — verify that a
 * credential is *present* and pool-healthy, but say nothing about whether
 * the credential's *credit balance* is sufficient to run a task. On
 * 2026-05-23 every solve attempt for the day returned `HTTP 402` from
 * OpenRouter ("This request requires more credits, or fewer max_tokens.")
 * while readiness reported ready=true — the harness silently burned 12
 * sessions. This probe closes that gap.
 *
 * Fail-safe philosophy: a clearly-confirmed insufficient-credit signal flips
 * `ready=false`; anything ambiguous (network failure, non-200, missing key)
 * returns `state=unknown` so the caller treats the harness as ready. The
 * inverse false-negative — shutting every operator down because OpenRouter
 * is transiently down — is worse than the original bug.
 */
export async function probeOpenRouterCredit(
  config: OpenRouterCreditConfig = {},
): Promise<OpenRouterCreditStatus> {
  const floorUsd = config.floorUsd ?? DEFAULT_OPENROUTER_CREDIT_FLOOR_USD;
  const apiKey = config.apiKey ?? process.env['OPENROUTER_API_KEY'];
  const fetchFn = config.fetchFn ?? fetch;
  const timeoutMs = config.timeoutMs ?? 5_000;

  // No API key → unknown (fail-safe). The auth-list gate would have caught
  // a missing credential already; if we somehow get here without one, do
  // not flip the operator into not-ready on a probe we can't even run.
  if (!apiKey) {
    return { state: 'unknown', floorUsd, reason: 'OPENROUTER_API_KEY not set' };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchFn('https://openrouter.ai/api/v1/key', {
      method: 'GET',
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: controller.signal,
    });
    if (!response.ok) {
      // Non-200 (including 401/403/5xx) — unknown, not exhausted. A 401
      // would imply the credential is broken, but the auth-list gate
      // already covered presence; treating an auth-broken state here as
      // "exhausted" would mis-classify it. Fail-safe to unknown.
      const raw = await safeReadResponse(response);
      return {
        state: 'unknown',
        floorUsd,
        reason: `OpenRouter /api/v1/key returned HTTP ${response.status}`,
        raw,
      };
    }
    const body = (await response.json()) as {
      data?: { limit?: number | null; usage?: number; limit_remaining?: number | null };
    } | null;
    const data = body?.data;
    if (!data || typeof data !== 'object') {
      return { state: 'unknown', floorUsd, reason: 'OpenRouter /api/v1/key returned malformed body' };
    }
    const usageUsd = typeof data.usage === 'number' ? data.usage : 0;
    // `limit` can be `null` for unlimited keys — treat that as plenty of credit.
    // `undefined` means the field was absent from the response body, which is
    // ambiguous (API schema drift?) — return `unknown` so a future shape
    // change does not silently pass readiness.
    if (data.limit === null) {
      return { state: 'ok', floorUsd, limitUsd: null, usageUsd };
    }
    if (data.limit === undefined) {
      return { state: 'unknown', floorUsd, reason: 'OpenRouter /api/v1/key response missing `data.limit`' };
    }
    const limitUsd = data.limit;
    // Prefer the API's `data.limit_remaining` (authoritative for the current
    // billing window when the key has a periodic reset) over `limit - usage`
    // (which is all-time and underestimates remaining credit on resetting
    // keys). Fall back to the subtraction when `limit_remaining` is absent.
    const remainingUsd =
      typeof data.limit_remaining === 'number' ? data.limit_remaining : limitUsd - usageUsd;
    const state: OpenRouterCreditStatus['state'] = remainingUsd >= floorUsd ? 'ok' : 'exhausted';
    return { state, floorUsd, remainingUsd, limitUsd, usageUsd };
  } catch (err) {
    // Network error, timeout, abort, JSON parse failure — unknown (fail-safe).
    const reason = err instanceof Error ? err.message : String(err);
    return { state: 'unknown', floorUsd, reason };
  } finally {
    clearTimeout(timer);
  }
}

async function safeReadResponse(response: Response): Promise<string> {
  try {
    const text = await response.text();
    return text.slice(0, 4000);
  } catch {
    return '';
  }
}
