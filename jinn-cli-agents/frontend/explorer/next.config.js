const path = require('path');
const { loadEnvConfig } = require('@next/env');

// Load env vars from monorepo root (includes RPC_URL from Tenderly)
// before Next.js loads its own .env.local (which takes precedence)
loadEnvConfig(path.resolve(__dirname, '..', '..'));

/** @type {import('next').NextConfig} */
const nextConfig = {
  transpilePackages: ['@jinn/shared-ui'],
  outputFileTracingRoot: path.resolve(__dirname, '..', '..'),
  turbopack: {
    root: path.resolve(__dirname, '..', '..'),
  },
};

module.exports = nextConfig;
