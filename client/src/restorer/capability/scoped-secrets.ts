/**
 * Scoped secrets helper — produces a read-only view over a secrets
 * bag. The daemon stores the underlying map and re-issues a fresh
 * frozen view per `run()` call so revoked secrets stop reaching impls
 * promptly.
 */

import type { ScopedSecrets } from './index.js';

export function freezeSecrets(source: Record<string, string>): ScopedSecrets {
  return Object.freeze({ ...source });
}
