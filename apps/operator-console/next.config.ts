import type { NextConfig } from 'next';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Yarn `portal:` is a symlink into `packages/lifecycle-notifications`. Turbopack
// only resolves inside the project root, so without lifting that root to the
// repo it reports "Can't resolve '@jinn-network/lifecycle-notifications'".
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '../..');

const nextConfig: NextConfig = {
  // No rewrite that would proxy around the UI token. The browser talks to
  // the daemon origin with `x-jinn-ui-token` (headless §9).
  outputFileTracingRoot: repoRoot,
  transpilePackages: ['@jinn-network/lifecycle-notifications'],
  turbopack: {
    root: repoRoot,
  },
  experimental: {
    optimizePackageImports: ['lucide-react'],
  },
};

export default nextConfig;
