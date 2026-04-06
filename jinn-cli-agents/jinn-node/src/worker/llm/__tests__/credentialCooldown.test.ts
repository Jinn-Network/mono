import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  checkGeminiQuotaAvailability,
  markCredentialExhausted,
  selectAvailableCredential,
  waitForGeminiQuota,
  isGeminiQuotaError,
} from '../geminiQuota.js';

// Mock the dependencies
vi.mock('../../../logging/index.js', () => ({
  workerLogger: {
    info: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock('../../../config/index.js', () => ({
  getOptionalGeminiApiKey: vi.fn(() => null),
  getOptionalGeminiQuotaBackoffMs: vi.fn(() => null),
  getOptionalGeminiQuotaMaxBackoffMs: vi.fn(() => null),
  getOptionalGeminiQuotaCheckModel: vi.fn(() => null),
  getOptionalGeminiQuotaCheckTimeoutMs: vi.fn(() => null),
}));

vi.mock('../authIntegration.js', () => ({
  getGeminiCredentialFromAuthManager: vi.fn(() => null),
  syncAndWriteGeminiCredentials: vi.fn(),
}));

vi.mock('google-auth-library', () => ({
  OAuth2Client: vi.fn().mockImplementation(() => ({
    setCredentials: vi.fn(),
    refreshAccessToken: vi.fn().mockResolvedValue({
      credentials: { access_token: 'mock-token' },
    }),
  })),
}));

vi.mock('fs', async (importOriginal) => {
  const actual = (await importOriginal()) as any;
  return {
    ...actual,
    existsSync: vi.fn(() => false),
    mkdirSync: vi.fn(),
    writeFileSync: vi.fn(),
    readFileSync: vi.fn(),
    unlinkSync: vi.fn(),
  };
});

const MOCK_CRED = JSON.stringify([
  {
    oauth_creds: {
      access_token: 'token-0',
      refresh_token: 'refresh-0',
      expiry_date: Date.now() + 3600000,
    },
    google_accounts: { active: 'user0@test.com' },
  },
]);

describe('credential cooldown', () => {
  beforeEach(() => {
    vi.stubEnv('GEMINI_OAUTH_CREDENTIALS', MOCK_CRED);
    // Mock the retrieveUserQuota endpoint — always says "quota available"
    // (this is the bug we're fixing: endpoint lies about RPM limits)
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        buckets: [{ remainingAmount: '100', modelId: 'gemini-3-flash' }],
      }),
    }) as any;
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('selectAvailableCredential returns credential when not in cooldown', async () => {
    const result = await selectAvailableCredential({ model: 'gemini-3-flash' });
    expect(result.selectedCredential).not.toBeNull();
    expect(result.selectedIndex).toBe(0);
    expect(result.allExhausted).toBe(false);
  });

  it('selectAvailableCredential skips credential in cooldown', async () => {
    markCredentialExhausted(0, 60_000);

    const result = await selectAvailableCredential({ model: 'gemini-3-flash' });
    expect(result.selectedCredential).toBeNull();
    expect(result.allExhausted).toBe(true);
  });

  it('credential cooldown expires and allows re-selection', async () => {
    markCredentialExhausted(0, 1);
    await new Promise((r) => setTimeout(r, 5));

    const result = await selectAvailableCredential({ model: 'gemini-3-flash' });
    expect(result.selectedCredential).not.toBeNull();
    expect(result.selectedIndex).toBe(0);
  });
});

describe('waitForGeminiQuota with API key fallback', () => {
  beforeEach(() => {
    vi.stubEnv('GEMINI_OAUTH_CREDENTIALS', MOCK_CRED);
    vi.stubEnv('GEMINI_API_KEY', 'fake-api-key');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('falls back to API key when all OAuth credentials are in cooldown', async () => {
    // Mock: retrieveUserQuota says "available" (the lying endpoint)
    // AND the API key generateContent check also succeeds
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        buckets: [{ remainingAmount: '100', modelId: 'gemini-3-flash' }],
      }),
    }) as any;

    // First call: OAuth credential selected normally
    const first = await waitForGeminiQuota({ model: 'gemini-3-flash' });
    expect(first.selectedIndex).toBe(0);
    expect(first.selectedCredential).not.toBeNull();

    // Simulate CLI quota error feedback (what jobRunner does)
    markCredentialExhausted(first.selectedIndex);

    // Second call: OAuth in cooldown → should fall back to API key
    const second = await waitForGeminiQuota({ model: 'gemini-3-flash' });
    expect(second.selectedCredential).toBeNull();
    expect(second.selectedIndex).toBe(-1);
    expect(second.allExhausted).toBe(false); // not blocked, using API key
  });
});

describe('checkGeminiQuotaAvailability', () => {
  beforeEach(() => {
    vi.stubEnv('GEMINI_OAUTH_CREDENTIALS', MOCK_CRED);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('reports unavailable when all credentials are exhausted and no API key fallback exists', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        buckets: [{ remainingAmount: '100', modelId: 'gemini-3-flash' }],
      }),
    }) as any;

    markCredentialExhausted(0, 60_000);

    const result = await checkGeminiQuotaAvailability({ model: 'gemini-3-flash' });
    expect(result.available).toBe(false);
    expect(result.allExhausted).toBe(true);
    expect(result.retryAfterMs).toBeGreaterThan(0);
  });

  it('reports available when API key fallback is healthy', async () => {
    vi.stubEnv('GEMINI_API_KEY', 'fake-api-key');

    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        buckets: [{ remainingAmount: '100', modelId: 'gemini-3-flash' }],
      }),
    }) as any;

    markCredentialExhausted(0, 60_000);

    const result = await checkGeminiQuotaAvailability({ model: 'gemini-3-flash' });
    expect(result.available).toBe(true);
    expect(result.selectedCredential).toBeNull();
    expect(result.selectedIndex).toBe(-1);
  });
});

describe('isGeminiQuotaError detection', () => {
  it('detects TerminalQuotaError from Gemini CLI', () => {
    // This is the actual error shape thrown by agent.ts (line 791)
    const err = new Error('Gemini process exited with code 1');
    (err as any).stderr =
      'TerminalQuotaError: You have exhausted your daily quota on gemini-3-flash';

    expect(isGeminiQuotaError({ error: err, telemetry: {} })).toBe(true);
  });

  it('detects quota error in telemetry', () => {
    expect(
      isGeminiQuotaError({
        telemetry: {
          errorMessage: 'resource_exhausted: rate limit exceeded',
        },
      })
    ).toBe(true);
  });

  it('does not flag non-quota errors', () => {
    const err = new Error('Connection refused');
    expect(isGeminiQuotaError(err)).toBe(false);
  });
});
