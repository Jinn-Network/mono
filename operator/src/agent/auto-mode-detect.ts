/**
 * Detects whether the local `claude` binary supports Auto Mode.
 *
 * Auto Mode requires Claude Code v2.1.83+. Available on Max/Team/Enterprise/API
 * plans (NOT Pro). Plan-detection is out of band — we just check the version.
 * If the user's plan doesn't allow Auto Mode, the binary itself rejects the flag
 * at runtime; the embedded session will fall back to the default permission
 * mode automatically.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileP = promisify(execFile);

const MIN_VERSION = { major: 2, minor: 1, patch: 83 };

export interface AutoModeAvailability {
  available: boolean;
  reason: string;
  version?: string;
}

export async function detectAutoModeAvailable(claudePath: string): Promise<AutoModeAvailability> {
  try {
    const { stdout } = await execFileP(claudePath, ['--version'], { timeout: 4000 });
    const versionMatch = /(\d+)\.(\d+)\.(\d+)/.exec(stdout);
    if (!versionMatch) {
      return { available: false, reason: 'could not parse claude --version output' };
    }
    const major = Number(versionMatch[1]);
    const minor = Number(versionMatch[2]);
    const patch = Number(versionMatch[3]);
    const versionStr = `${major}.${minor}.${patch}`;
    const isOld =
      major < MIN_VERSION.major ||
      (major === MIN_VERSION.major && minor < MIN_VERSION.minor) ||
      (major === MIN_VERSION.major && minor === MIN_VERSION.minor && patch < MIN_VERSION.patch);
    if (isOld) {
      return {
        available: false,
        reason: `Claude Code ${versionStr} is older than required ${MIN_VERSION.major}.${MIN_VERSION.minor}.${MIN_VERSION.patch} for Auto Mode`,
        version: versionStr,
      };
    }
    return { available: true, reason: 'ok', version: versionStr };
  } catch (err) {
    return {
      available: false,
      reason: `claude --version failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}
