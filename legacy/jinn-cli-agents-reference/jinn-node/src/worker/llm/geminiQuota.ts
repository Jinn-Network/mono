import { workerLogger } from '../../logging/index.js';
import { config, secrets } from '../../config/index.js';
import { serializeError } from '../logging/errors.js';
import { DEFAULT_WORKER_MODEL, normalizeGeminiModel } from '../../shared/gemini-models.js';
import { OAuth2Client } from 'google-auth-library';
import { homedir } from 'os';
import { join } from 'path';
import { mkdirSync, writeFileSync, readFileSync, existsSync, unlinkSync } from 'fs';
import {
  getGeminiCredentialFromAuthManager,
  syncAndWriteGeminiCredentials,
  type GeminiCredentialSet,
} from './authIntegration.js';

type QuotaCheckOptions = {
  model?: string;
  timeoutMs?: number;
};

type QuotaCheckResult = {
  ok: boolean;
  checked: boolean;
  isQuotaError: boolean;
  status?: number;
  detail?: string;
  retryAfterMs?: number;
};

type QuotaWaitOptions = {
  reason?: string;
  requestId?: string;
  jobName?: string;
  model?: string;
};

// Multi-credential rotation types
interface OAuthCredentialSet {
  oauth_creds: Record<string, unknown>;
  google_accounts: Record<string, unknown>;
}

export interface CredentialSelectionResult {
  selectedCredential: OAuthCredentialSet | null;
  selectedIndex: number;
  allExhausted: boolean;
}

export interface GeminiQuotaAvailabilityResult extends CredentialSelectionResult {
  available: boolean;
  checked?: boolean;
  detail?: string;
  retryAfterMs?: number;
}

const DEFAULT_MODEL = DEFAULT_WORKER_MODEL;
const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_BACKOFF_MS = 60_000;
const DEFAULT_MAX_BACKOFF_MS = 10 * 60_000;

let loggedMissingKey = false;
let loggedNonQuotaFailure = false;

// Cooldown map: credential index → expiry timestamp.
// Populated when the Gemini CLI itself reports a quota error (TerminalQuotaError),
// which the retrieveUserQuota endpoint may not reflect (it misses RPM limits).
const credentialCooldownMap = new Map<number, number>();
const DEFAULT_CREDENTIAL_COOLDOWN_MS = 5 * 60_000; // 5 minutes

/**
 * Mark an OAuth credential as temporarily exhausted after a CLI quota error.
 * selectAvailableCredential() will skip credentials in cooldown.
 */
export function markCredentialExhausted(
  index: number,
  cooldownMs: number = DEFAULT_CREDENTIAL_COOLDOWN_MS
): void {
  const expiry = Date.now() + cooldownMs;
  credentialCooldownMap.set(index, expiry);
  workerLogger.info(
    { credentialIndex: index, cooldownMs, expiresAt: new Date(expiry).toISOString() },
    'Credential marked as exhausted (CLI quota error feedback)'
  );
}

function isCredentialInCooldown(index: number): boolean {
  const expiry = credentialCooldownMap.get(index);
  if (!expiry) return false;
  if (Date.now() >= expiry) {
    credentialCooldownMap.delete(index);
    return false;
  }
  return true;
}

function normalizeModel(model: string): string {
  const trimmed = model.trim();
  return trimmed.startsWith('models/') ? trimmed.slice('models/'.length) : trimmed;
}

function resolveModel(preferred?: string): string {
  const configuredModel = config.llm.quotaCheckModel;
  if (configuredModel && configuredModel.trim().length > 0) {
    return normalizeModel(configuredModel);
  }
  if (preferred && preferred.startsWith('gemini-')) {
    return normalizeModel(preferred);
  }
  return DEFAULT_MODEL;
}

function parseRetryAfterMs(value: string | null): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) {
    return Math.max(0, Math.floor(seconds * 1000));
  }
  const timestamp = Date.parse(value);
  if (!Number.isNaN(timestamp)) {
    return Math.max(0, timestamp - Date.now());
  }
  return undefined;
}

function getNextCredentialCooldownMs(): number | undefined {
  let nextRetryAfterMs: number | undefined;
  const now = Date.now();

  for (const expiry of credentialCooldownMap.values()) {
    const retryAfterMs = expiry - now;
    if (retryAfterMs <= 0) continue;
    if (nextRetryAfterMs === undefined || retryAfterMs < nextRetryAfterMs) {
      nextRetryAfterMs = retryAfterMs;
    }
  }

  return nextRetryAfterMs;
}

function computeBackoffMs(attempt: number, baseMs: number, maxMs: number): number {
  const exponential = Math.min(maxMs, baseMs * Math.pow(2, attempt));
  const jitter = Math.floor(exponential * 0.2 * Math.random());
  return Math.min(maxMs, exponential + jitter);
}

function truncate(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  return `${value.slice(0, maxLength)}...`;
}

function isQuotaText(text: string): boolean {
  const lower = text.toLowerCase();
  return (
    lower.includes('resource_exhausted') ||
    lower.includes('terminalquotaerror') ||
    lower.includes('quota') ||
    lower.includes('rate limit') ||
    lower.includes('too many requests') ||
    lower.includes('limit reached') ||
    lower.includes('insufficient_quota') ||
    lower.includes('429')
  );
}

// Extract model family for matching (e.g., "gemini-3-flash" -> "gemini-3", "gemini-2.5-flash" -> "gemini-2.5")
function extractModelFamily(model: string): string | undefined {
  const match = model.match(/gemini-[\d.]+/i);
  return match?.[0]?.toLowerCase();
}

export function isGeminiQuotaError(error: unknown): boolean {
  if (!error) return false;
  const parts: string[] = [];
  const push = (value: unknown) => {
    if (typeof value === 'string' && value.trim().length > 0) {
      parts.push(value);
    }
  };

  if (typeof error === 'string') {
    push(error);
  } else if (error instanceof Error) {
    push(error.message);
    push((error as any).stderr);
  }

  if (typeof error === 'object' && error !== null) {
    const err = error as any;
    push(err.message);
    push(err.stderr);
    push(err.error?.message);
    push(err.error?.stderr);
    push(err.telemetry?.errorMessage);
    push(err.telemetry?.raw?.stderrWarnings);
    push(err.telemetry?.raw?.stderr);
    push(err.telemetry?.raw?.error);
  }

  if (parts.length === 0) return false;
  return isQuotaText(parts.join('\n'));
}

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Gemini CLI's OAuth client credentials for token refresh
const OAUTH_CLIENT_ID = process.env.GEMINI_OAUTH_CLIENT_ID || '';
const OAUTH_CLIENT_SECRET = process.env.GEMINI_OAUTH_CLIENT_SECRET || '';

// Parse multi-credential array from env var
function parseCredentialsArray(): OAuthCredentialSet[] | null {
  const credsJson = secrets.geminiOauthCredentials;
  if (!credsJson) {
    return null;
  }
  try {
    const parsed = JSON.parse(credsJson);
    if (!Array.isArray(parsed) || parsed.length === 0) {
      workerLogger.warn({}, 'GEMINI_OAUTH_CREDENTIALS is not a valid non-empty array');
      return null;
    }
    return parsed as OAuthCredentialSet[];
  } catch (e: any) {
    workerLogger.warn({ error: e.message }, 'Failed to parse GEMINI_OAUTH_CREDENTIALS');
    return null;
  }
}

// Check quota for a single credential set
async function checkOAuthQuotaForCredential(
  cred: OAuthCredentialSet,
  model?: string,
  timeoutMs?: number
): Promise<QuotaCheckResult> {
  try {
    const oauthCreds = cred.oauth_creds as any;
    let accessToken = oauthCreds.access_token;

    // Refresh token if expired
    if (oauthCreds.expiry_date && Date.now() > oauthCreds.expiry_date) {
      workerLogger.info({}, 'OAuth access token expired, refreshing...');

      if (!oauthCreds.refresh_token) {
        return { ok: true, checked: false, isQuotaError: false, detail: 'Token expired, no refresh token' };
      }

      try {
        const oauth2Client = new OAuth2Client(OAUTH_CLIENT_ID, OAUTH_CLIENT_SECRET);
        oauth2Client.setCredentials({ refresh_token: oauthCreds.refresh_token });
        const { credentials } = await oauth2Client.refreshAccessToken();
        accessToken = credentials.access_token;
        workerLogger.info({}, 'OAuth token refreshed for quota check');
      } catch (refreshError: any) {
        workerLogger.warn({ error: refreshError.message }, 'Failed to refresh OAuth token');
        return { ok: true, checked: false, isQuotaError: false, detail: `Token refresh failed: ${refreshError.message}` };
      }
    }

    // Call CodeAssist retrieveUserQuota endpoint
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs ?? DEFAULT_TIMEOUT_MS);

    try {
      const url = 'https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuota';
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${accessToken}`,
        },
        body: JSON.stringify({ project: 'user' }),
        signal: controller.signal,
      });

      if (!response.ok) {
        const text = await response.text();
        const isQuotaError = response.status === 429 || isQuotaText(text);
        return {
          ok: !isQuotaError,
          checked: true,
          isQuotaError,
          status: response.status,
          detail: truncate(text, 240),
        };
      }

      const quota = await response.json() as { buckets?: Array<{ remainingAmount?: string; remainingFraction?: number; modelId?: string; resetTime?: string }> };

      // Check if the specific model family has remaining quota
      const normalizedModel = model ? normalizeModel(model) : undefined;
      const requestedFamily = normalizedModel ? extractModelFamily(normalizedModel) : undefined;

      const hasQuota = quota.buckets?.some((b) => {
        if (requestedFamily && b.modelId) {
          const bucketFamily = extractModelFamily(b.modelId);
          if (bucketFamily && requestedFamily !== bucketFamily) {
            return false;
          }
        }
        const remaining = parseFloat(b.remainingAmount || '0');
        return remaining > 0 || (b.remainingFraction !== undefined && b.remainingFraction > 0);
      }) ?? true;

      return { ok: hasQuota, checked: true, isQuotaError: !hasQuota };
    } finally {
      clearTimeout(timeout);
    }
  } catch (error: any) {
    workerLogger.warn({ error: error.message }, 'OAuth quota check failed');
    return { ok: true, checked: false, isQuotaError: false, detail: error.message };
  }
}

// Get the active account from the volume (if exists)
function getVolumeActiveAccount(): string | null {
  const googleAccountsPath = join(homedir(), '.gemini', 'google_accounts.json');

  if (!existsSync(googleAccountsPath)) {
    return null;
  }

  try {
    const content = readFileSync(googleAccountsPath, 'utf-8');
    const accounts = JSON.parse(content);
    return accounts.active || null;
  } catch {
    return null;
  }
}

// Write selected credential to ~/.gemini/ (skips write if same account already on volume)
function writeCredentialToGeminiDir(cred: OAuthCredentialSet, index: number): void {
  const userGeminiDir = join(homedir(), '.gemini');

  // Check if volume already has this account's credentials
  const volumeAccount = getVolumeActiveAccount();
  const selectedAccount = (cred.google_accounts as any)?.active;

  if (volumeAccount && selectedAccount && volumeAccount === selectedAccount) {
    workerLogger.info(
      { credentialIndex: index, account: selectedAccount },
      'Volume already has credentials for this account, preserving refreshed tokens'
    );

    // Still write settings.json (it's shared and small)
    if (process.env.GEMINI_SETTINGS) {
      writeFileSync(join(userGeminiDir, 'settings.json'), process.env.GEMINI_SETTINGS);
    }
    return;
  }

  // Different account or no existing credentials - write everything
  mkdirSync(userGeminiDir, { recursive: true });

  writeFileSync(join(userGeminiDir, 'oauth_creds.json'), JSON.stringify(cred.oauth_creds));
  writeFileSync(join(userGeminiDir, 'google_accounts.json'), JSON.stringify(cred.google_accounts));

  if (process.env.GEMINI_SETTINGS) {
    writeFileSync(join(userGeminiDir, 'settings.json'), process.env.GEMINI_SETTINGS);
  }

  workerLogger.info(
    { credentialIndex: index, account: selectedAccount, previousAccount: volumeAccount },
    'Wrote OAuth credentials to ~/.gemini/'
  );
}

// Remove OAuth creds from ~/.gemini/ so the Gemini CLI falls back to API key.
// The CLI prioritizes OAuth creds on disk over the settings.json selectedType,
// so we must remove them to force API key auth.
function clearOAuthCredsFromDisk(): void {
  const userGeminiDir = join(homedir(), '.gemini');
  for (const file of ['oauth_creds.json', 'google_accounts.json']) {
    const path = join(userGeminiDir, file);
    try {
      if (existsSync(path)) {
        unlinkSync(path);
        workerLogger.info({ file }, 'Removed OAuth credential file for API key fallback');
      }
    } catch (err: any) {
      workerLogger.debug({ file, error: err.message }, 'Failed to remove OAuth credential file');
    }
  }
}

// Select first credential with available quota and write it to ~/.gemini/
export async function selectAvailableCredential(
  options?: { model?: string }
): Promise<CredentialSelectionResult> {
  const credentials = parseCredentialsArray();

  if (!credentials) {
    // Try AuthManager as fallback for zero-friction onboarding
    const authManagerCred = getGeminiCredentialFromAuthManager();
    if (authManagerCred) {
      workerLogger.info({ source: 'AuthManager' }, 'Using Gemini credentials discovered by AuthManager');
      // Write to ~/.gemini/ so Gemini CLI can use them
      syncAndWriteGeminiCredentials();
      return { selectedCredential: authManagerCred as unknown as OAuthCredentialSet, selectedIndex: 0, allExhausted: false };
    }
    return { selectedCredential: null, selectedIndex: -1, allExhausted: false };
  }

  for (let i = 0; i < credentials.length; i++) {
    const cred = credentials[i];

    // Skip credentials in cooldown (marked exhausted by CLI quota error feedback)
    if (isCredentialInCooldown(i)) {
      workerLogger.info({ credentialIndex: i, total: credentials.length }, 'Skipping credential (in cooldown from CLI quota error)');
      continue;
    }

    workerLogger.info({ credentialIndex: i, total: credentials.length }, 'Checking credential quota');

    const result = await checkOAuthQuotaForCredential(cred, options?.model);

    if (result.ok || !result.checked) {
      workerLogger.info({ credentialIndex: i }, 'Found credential with available quota');
      writeCredentialToGeminiDir(cred, i);
      return { selectedCredential: cred, selectedIndex: i, allExhausted: false };
    }

    workerLogger.warn({ credentialIndex: i, detail: result.detail }, 'Credential quota exhausted');
  }

  workerLogger.warn({ totalCredentials: credentials.length }, 'All credentials exhausted');
  return { selectedCredential: null, selectedIndex: -1, allExhausted: true };
}

export async function checkGeminiQuotaAvailability(
  options: QuotaWaitOptions = {}
): Promise<GeminiQuotaAvailabilityResult> {
  const model = resolveModel(options.model);
  const selection = await selectAvailableCredential({ model });

  if (selection.selectedCredential) {
    return {
      ...selection,
      available: true,
      checked: true,
    };
  }

  if (!selection.allExhausted) {
    const result = await checkGeminiQuota({ model });
    return {
      ...selection,
      available: result.ok || !result.checked,
      checked: result.checked,
      detail: result.detail,
      retryAfterMs: result.retryAfterMs,
    };
  }

  const apiKey = secrets.geminiApiKey || process.env.GEMINI_API_KEY;
  if (apiKey) {
    const apiKeyResult = await checkGeminiQuota({ model });
    if (apiKeyResult.ok || !apiKeyResult.checked) {
      clearOAuthCredsFromDisk();
      return {
        selectedCredential: null,
        selectedIndex: -1,
        allExhausted: false,
        available: true,
        checked: apiKeyResult.checked,
        detail: apiKeyResult.detail,
        retryAfterMs: apiKeyResult.retryAfterMs,
      };
    }

    return {
      ...selection,
      available: false,
      checked: apiKeyResult.checked,
      detail: apiKeyResult.detail,
      retryAfterMs: apiKeyResult.retryAfterMs ?? getNextCredentialCooldownMs(),
    };
  }

  return {
    ...selection,
    available: false,
    checked: true,
    detail: 'All OAuth credentials exhausted',
    retryAfterMs: getNextCredentialCooldownMs(),
  };
}

export async function checkGeminiQuota(
  options: QuotaCheckOptions = {}
): Promise<QuotaCheckResult> {
  // Existing API key quota check
  const apiKey = secrets.geminiApiKey;
  if (!apiKey) {
    return {
      ok: true,
      checked: false,
      isQuotaError: false,
      detail: 'GEMINI_API_KEY not set',
    };
  }

  const model = normalizeGeminiModel(resolveModel(options.model), DEFAULT_WORKER_MODEL).normalized;
  const timeoutMs = options.timeoutMs ?? config.llm.quotaCheckTimeoutMs ?? DEFAULT_TIMEOUT_MS;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${apiKey}`;
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [
          {
            role: 'user',
            parts: [{ text: 'ping' }],
          },
        ],
        generationConfig: {
          maxOutputTokens: 1,
          temperature: 0,
        },
      }),
      signal: controller.signal,
    });

    if (response.ok) {
      return {
        ok: true,
        checked: true,
        isQuotaError: false,
        status: response.status,
      };
    }

    const text = await response.text();
    const isQuotaError = isQuotaText(text) || response.status === 429;
    return {
      ok: !isQuotaError,
      checked: true,
      isQuotaError,
      status: response.status,
      detail: text ? truncate(text, 240) : undefined,
      retryAfterMs: parseRetryAfterMs(response.headers.get('retry-after')),
    };
  } catch (error: any) {
    const isQuotaError = isGeminiQuotaError(error);
    return {
      ok: !isQuotaError,
      checked: true,
      isQuotaError,
      detail: truncate(serializeError(error), 240),
    };
  } finally {
    clearTimeout(timeout);
  }
}

export async function waitForGeminiQuota(options: QuotaWaitOptions = {}): Promise<CredentialSelectionResult> {
  const baseBackoffMs = config.llm.quotaBackoffMs ?? DEFAULT_BACKOFF_MS;
  const maxBackoffMs = config.llm.quotaMaxBackoffMs ?? DEFAULT_MAX_BACKOFF_MS;
  const model = resolveModel(options.model);

  for (let attempt = 0; ; attempt += 1) {
    const availability = await checkGeminiQuotaAvailability(options);

    if (availability.available) {
      if (availability.selectedCredential) {
        return availability;
      }

      if (!loggedMissingKey && availability.checked === false) {
        loggedMissingKey = true;
        workerLogger.info({ model }, 'Skipping Gemini quota check (GEMINI_API_KEY not set)');
      } else if (availability.detail && !loggedNonQuotaFailure) {
        loggedNonQuotaFailure = true;
        workerLogger.warn({ model, detail: availability.detail }, 'Gemini quota check failed; continuing without wait');
      }

      return availability;
    }

    const waitMs = availability.retryAfterMs && availability.retryAfterMs > 0
      ? Math.min(maxBackoffMs, availability.retryAfterMs)
      : computeBackoffMs(attempt, baseBackoffMs, maxBackoffMs);

    workerLogger.warn({
      reason: options.reason,
      requestId: options.requestId,
      jobName: options.jobName,
      model,
      attempt: attempt + 1,
      waitMs,
      detail: availability.detail,
      allExhausted: availability.allExhausted,
    }, availability.allExhausted ? 'All credentials exhausted; waiting before retry' : 'Gemini quota exhausted; waiting before retry');

    await sleep(waitMs);
  }
}
