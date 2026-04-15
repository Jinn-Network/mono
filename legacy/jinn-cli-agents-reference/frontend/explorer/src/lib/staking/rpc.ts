import { createPublicClient, http, type PublicClient } from 'viem'
import { base } from 'viem/chains'
import fs from 'fs'
import path from 'path'

/**
 * Module-level singleton RPC client with multicall batching.
 *
 * Loads RPC_URL from monorepo root .env directly — cannot rely on next.config.js
 * loadEnvConfig because turbopack API route workers don't inherit those vars.
 *
 * RPC URL resolution order:
 *   1. RPC_URL (set in root .env — Tenderly)
 *   2. BASE_RPC_URL (alias)
 *   Throws if neither is set. No public RPC fallback.
 */

// Ensure monorepo root .env is loaded in this runtime context.
// Walk up from cwd to find the monorepo root .env (contains RPC_URL).
if (!process.env.RPC_URL && !process.env.BASE_RPC_URL) {
  let dir = process.cwd()
  for (let i = 0; i < 5; i++) {
    const envPath = path.join(dir, '.env')
    if (fs.existsSync(envPath)) {
      const content = fs.readFileSync(envPath, 'utf-8')
      for (const line of content.split('\n')) {
        const match = line.match(/^(RPC_URL|BASE_RPC_URL)=(.+)/)
        if (match && !process.env[match[1]]) {
          process.env[match[1]] = match[2].trim().replace(/^["']|["']$/g, '')
        }
      }
      if (process.env.RPC_URL || process.env.BASE_RPC_URL) break
    }
    dir = path.dirname(dir)
  }
}

let _client: PublicClient | null = null
let _clientRpcUrl: string | null = null

export function getRpcUrl(): string {
  const rpcUrl = (process.env.RPC_URL || process.env.BASE_RPC_URL || '').trim()
  if (!rpcUrl) {
    throw new Error('[staking/rpc] RPC_URL or BASE_RPC_URL must be set — do NOT use public RPCs')
  }
  return rpcUrl
}

export function getRpcClient(): PublicClient {
  const rpcUrl = getRpcUrl()

  // Recreate if RPC URL changed (e.g. env reload in dev)
  if (_client && _clientRpcUrl === rpcUrl) {
    return _client
  }

  if (!_clientRpcUrl) {
    const source = process.env.RPC_URL ? 'RPC_URL' : 'BASE_RPC_URL'
    console.log(`[staking/rpc] Creating client from ${source}: ${rpcUrl.replace(/\/[a-f0-9-]{20,}$/i, '/***')}`)
  }

  const proxyToken = process.env.RPC_PROXY_TOKEN
  const transportOptions = proxyToken
    ? { fetchOptions: { headers: { Authorization: `Bearer ${proxyToken}` } } }
    : {}

  _client = createPublicClient({
    chain: base,
    transport: http(rpcUrl, transportOptions),
    batch: {
      multicall: true,
    },
  }) as PublicClient
  _clientRpcUrl = rpcUrl

  return _client
}
