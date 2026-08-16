/**
 * Best-effort cross-platform "open this URL in the user's default browser".
 * Silent if the platform-specific launcher isn't available.
 */
import { spawn } from 'node:child_process';

export function openBrowser(url: string): void {
  const platform = process.platform;
  const cmd = platform === 'darwin' ? 'open'
            : platform === 'win32'  ? 'start'
            : 'xdg-open';
  try {
    const child = spawn(cmd, [url], { detached: true, stdio: 'ignore' });
    child.on('error', () => {
      // best-effort; never crash the daemon over a failed browser launch
    });
    child.unref();
  } catch {
    // best-effort; never crash the daemon over a failed browser launch
  }
}
