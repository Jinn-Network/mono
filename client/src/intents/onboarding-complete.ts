/**
 * Onboarding-complete intent module.
 *
 * Per spec §4.1/§11, a control route is a thin front-end over a pure intent
 * module — this copies `intents/claim-rewards.ts`'s shape. Unlike
 * claim-rewards, this intent does not broadcast anything (it's a config
 * write, not a chain call), so there is no analogue to claim-rewards'
 * module-level single-flight queue — writing the same
 * `onboardingComplete: true` value twice is naturally idempotent.
 *
 * Unlike bootstrap-retry, this intent CAN run standalone: the write is
 * just `persistTopLevelConfigValue('onboardingComplete', true, configPath)`,
 * meaningful whether or not a daemon is currently running (a daemon that
 * boots later reads the flag fresh from disk). `markOnboardingComplete` is
 * an optional extra step — supplied only by the HTTP route front-end
 * (`api/setup-endpoints.ts`), which reuses the daemon's own live in-memory
 * config so a running daemon's `GET /v1/bootstrap` reflects the flag
 * immediately rather than after a restart. The standalone CLI front-end
 * (`cli/commands/onboarding-complete.ts`) omits it — there is no in-memory
 * daemon config for a standalone process to update.
 */
import { persistTopLevelConfigValue } from '../config.js';

export interface OnboardingCompleteIntentInput {
  /** Config file path to write `onboardingComplete: true` into. */
  configPath?: string;
  /** Injectable for tests; defaults to the real config-file writer. */
  persistConfigValue?: typeof persistTopLevelConfigValue;
  /**
   * Optional live in-memory sync for an already-running daemon. See module
   * docstring — absent for the standalone CLI front-end.
   */
  markOnboardingComplete?: () => void;
}

export interface OnboardingCompleteIntentResult {
  schemaVersion: 1;
  generatedAt: string;
  verb: 'onboarding-complete';
  ok: boolean;
  onboardingComplete: boolean;
  configPath?: string;
  error?: string;
}

function serializeError(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

export async function onboardingCompleteIntent(
  input: OnboardingCompleteIntentInput,
): Promise<OnboardingCompleteIntentResult> {
  const persist = input.persistConfigValue ?? persistTopLevelConfigValue;
  try {
    const configPath = persist('onboardingComplete', true, input.configPath);
    input.markOnboardingComplete?.();
    return {
      schemaVersion: 1,
      generatedAt: new Date().toISOString(),
      verb: 'onboarding-complete',
      ok: true,
      onboardingComplete: true,
      configPath,
    };
  } catch (err) {
    return {
      schemaVersion: 1,
      generatedAt: new Date().toISOString(),
      verb: 'onboarding-complete',
      ok: false,
      onboardingComplete: false,
      error: serializeError(err),
    };
  }
}
