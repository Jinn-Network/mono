import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { onboardingCompleteIntent } from '../../src/intents/onboarding-complete.js';

describe('onboardingCompleteIntent', () => {
  it('persists onboardingComplete: true to the given config path and reports ok:true', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'jinn-onboarding-complete-'));
    const configPath = join(dir, 'config.json');
    const result = await onboardingCompleteIntent({ configPath });
    expect(result.ok).toBe(true);
    expect(result.onboardingComplete).toBe(true);
    expect(result.verb).toBe('onboarding-complete');
  });

  it('calls the injected persistConfigValue with the expected key/value/path', async () => {
    const persistConfigValue = vi.fn().mockReturnValue('/tmp/whatever/config.json');
    const result = await onboardingCompleteIntent({
      configPath: '/tmp/whatever/config.json',
      persistConfigValue,
    });
    expect(persistConfigValue).toHaveBeenCalledWith('onboardingComplete', true, '/tmp/whatever/config.json');
    expect(result.ok).toBe(true);
    expect(result.configPath).toBe('/tmp/whatever/config.json');
  });

  it('calls markOnboardingComplete when supplied (live daemon in-memory sync)', async () => {
    const markOnboardingComplete = vi.fn();
    await onboardingCompleteIntent({
      configPath: '/tmp/whatever/config.json',
      persistConfigValue: vi.fn().mockReturnValue('/tmp/whatever/config.json'),
      markOnboardingComplete,
    });
    expect(markOnboardingComplete).toHaveBeenCalledOnce();
  });

  it('does not require markOnboardingComplete (daemon-down / standalone CLI use)', async () => {
    const result = await onboardingCompleteIntent({
      configPath: '/tmp/whatever/config.json',
      persistConfigValue: vi.fn().mockReturnValue('/tmp/whatever/config.json'),
    });
    expect(result.ok).toBe(true);
  });

  it('returns ok:false with a serialized error when the write fails', async () => {
    const persistConfigValue = vi.fn().mockImplementation(() => {
      throw new Error('disk full');
    });
    const result = await onboardingCompleteIntent({
      configPath: '/tmp/whatever/config.json',
      persistConfigValue,
    });
    expect(result.ok).toBe(false);
    expect(result.onboardingComplete).toBe(false);
    expect(result.error).toBe('disk full');
  });
});
