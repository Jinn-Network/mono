import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  // No rewrite that would proxy around the UI token. The browser talks to
  // the daemon origin with `x-jinn-ui-token` (headless §9).
  transpilePackages: ['@jinn-network/lifecycle-notifications'],
  experimental: {
    optimizePackageImports: ['lucide-react'],
  },
};

export default nextConfig;
