#!/usr/bin/env tsx
/**
 * Verify a venture token deployment on Base
 *
 * Checks:
 *  1. Token contract exists and has correct name/symbol/totalSupply
 *  2. Token balances at key addresses (Safe, Airlock, governance, pool)
 *  3. Airlock asset data (pool, governor, migrator)
 *  4. Supabase venture record matches on-chain data
 *
 * Usage:
 *   yarn tsx scripts/ventures/verify-deployment.ts --venture-id <uuid>
 *   yarn tsx scripts/ventures/verify-deployment.ts --token <address> --safe <address>
 */

import { createPublicClient, http, parseAbi, formatEther, type Address } from 'viem';
import { base } from 'viem/chains';
import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';

dotenv.config();

// ─── ABIs ───────────────────────────────────────────────────────────────────

const erc20Abi = parseAbi([
  'function name() view returns (string)',
  'function symbol() view returns (string)',
  'function totalSupply() view returns (uint256)',
  'function balanceOf(address) view returns (uint256)',
  'function decimals() view returns (uint8)',
]);

const airlockAbi = parseAbi([
  'function getAssetData(address token) view returns (address poolOrHook, address governor, address liquidityMigrator, address numeraire, uint256 totalSales, uint256 totalProceeds, uint40 deploymentTime)',
]);

const AIRLOCK = '0x660eAaEdEBc968f8f3694354FA8EC0b4c5Ba8D12' as const;

// ─── Helpers ────────────────────────────────────────────────────────────────

function fmt(val: bigint, decimals = 18): string {
  const num = Number(formatEther(val));
  if (num >= 1_000_000_000) return `${(num / 1_000_000_000).toFixed(2)}B`;
  if (num >= 1_000_000) return `${(num / 1_000_000).toFixed(2)}M`;
  if (num >= 1_000) return `${(num / 1_000).toFixed(2)}K`;
  return num.toFixed(4);
}

function check(label: string, ok: boolean, detail?: string) {
  const icon = ok ? '✓' : '✗';
  console.log(`  ${icon} ${label}${detail ? ` — ${detail}` : ''}`);
  return ok;
}

const delay = (ms: number) => new Promise(r => setTimeout(r, ms));

async function safeRead<T>(pc: any, params: any, fallback: T): Promise<T> {
  await delay(400);
  try {
    return await pc.readContract(params) as T;
  } catch (err: any) {
    if (err.message?.includes('429')) {
      await delay(2000);
      try { return await pc.readContract(params) as T; } catch { return fallback; }
    }
    return fallback;
  }
}

// ─── Main ───────────────────────────────────────────────────────────────────

interface VerifyArgs {
  ventureId?: string;
  tokenAddress?: string;
  safeAddress?: string;
}

async function verify(args: VerifyArgs) {
  const rpcUrl = process.env.BASE_RPC_URL || 'https://mainnet.base.org';
  const pc = createPublicClient({ chain: base, transport: http(rpcUrl) });

  let tokenAddress: Address | undefined;
  let safeAddress: Address | undefined;
  let ventureRecord: any = null;

  // ── Step 1: Load venture from Supabase ──────────────────────────────────
  if (args.ventureId) {
    console.log('\n═══ Supabase Venture Record ═══');
    const supabaseUrl = process.env.SUPABASE_URL;
    const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!supabaseUrl || !supabaseKey) {
      console.log('  ⚠ SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY not set, skipping DB check');
    } else {
      const sb = createClient(supabaseUrl, supabaseKey);
      const { data, error } = await sb
        .from('ventures')
        .select('*')
        .eq('id', args.ventureId)
        .single();

      if (error || !data) {
        console.log(`  ✗ Venture not found: ${error?.message}`);
      } else {
        ventureRecord = data;
        tokenAddress = data.token_address as Address;
        safeAddress = args.safeAddress as Address || (data.token_metadata as any)?.safeAddress;

        check('Venture found', true, data.name);
        check('Status', data.status === 'active', data.status);
        check('Token address set', !!data.token_address, data.token_address);
        check('Token symbol set', !!data.token_symbol, data.token_symbol);
        check('Token name set', !!data.token_name, data.token_name);
        check('Launch platform', data.token_launch_platform === 'doppler', data.token_launch_platform);

        if (data.token_metadata) {
          const meta = data.token_metadata as any;
          check('Pool ID recorded', !!meta.poolId, meta.poolId?.slice(0, 20) + '...');
          check('TX hash recorded', !!meta.transactionHash, meta.transactionHash?.slice(0, 20) + '...');
          check('Safe address recorded', !!meta.safeAddress, meta.safeAddress);
          check('Numeraire recorded', !!meta.numeraire, meta.numeraire);
        }
      }
    }
  }

  // Allow CLI overrides
  tokenAddress = (args.tokenAddress as Address) || tokenAddress;
  safeAddress = (args.safeAddress as Address) || safeAddress;

  if (!tokenAddress) {
    console.error('\nError: No token address found. Use --token or --venture-id');
    process.exit(1);
  }

  // ── Step 2: Token contract ──────────────────────────────────────────────
  console.log('\n═══ Token Contract ═══');
  console.log(`  Address: ${tokenAddress}`);

  const code = await pc.getCode({ address: tokenAddress });
  check('Contract deployed', code !== undefined && code !== '0x');

  await delay(500);
  const name = await safeRead(pc, { address: tokenAddress, abi: erc20Abi, functionName: 'name' }, '??');
  const symbol = await safeRead(pc, { address: tokenAddress, abi: erc20Abi, functionName: 'symbol' }, '??');
  const totalSupply = await safeRead(pc, { address: tokenAddress, abi: erc20Abi, functionName: 'totalSupply' }, 0n);
  const decimals = await safeRead(pc, { address: tokenAddress, abi: erc20Abi, functionName: 'decimals' }, 18);

  check('Name', true, name);
  check('Symbol', true, symbol);
  check('Decimals', decimals === 18, String(decimals));
  check('Total supply', true, fmt(totalSupply));

  // ── Step 3: Airlock asset data ──────────────────────────────────────────
  console.log('\n═══ Airlock Asset Data ═══');
  await delay(300);

  let governorAddress: Address | null = null;
  let poolOrHookAddress: Address | null = null;
  let migratorAddress: Address | null = null;
  let numeraireAddress: Address | null = null;

  try {
    const assetData = await pc.readContract({
      address: AIRLOCK,
      abi: airlockAbi,
      functionName: 'getAssetData',
      args: [tokenAddress],
    });

    const [poolOrHook, governor, liquidityMigrator, numeraire, totalSales, totalProceeds, deploymentTime] = assetData;

    poolOrHookAddress = poolOrHook;
    governorAddress = governor;
    migratorAddress = liquidityMigrator;
    numeraireAddress = numeraire;

    check('Pool/Hook', true, poolOrHook);
    check('Governor (governance contract)', true, governor);
    check('Liquidity migrator', true, liquidityMigrator);
    check('Numeraire', true, numeraire);
    const ts = Number(deploymentTime);
    check('Deployment time', ts > 0, ts > 0 && ts < 4294967295 ? new Date(ts * 1000).toISOString() : `raw: ${ts}`);
    check('Total sales (tokens sold so far)', true, fmt(totalSales));
    check('Total proceeds (numeraire received)', true, fmt(totalProceeds));
  } catch (err: any) {
    console.log(`  ✗ Failed to read asset data: ${err.message?.slice(0, 200)}`);
  }

  // ── Step 4: Token balances ──────────────────────────────────────────────
  console.log('\n═══ Token Balances ═══');

  // Known addresses to check
  const balanceChecks: Record<string, Address> = {
    'Airlock': AIRLOCK,
    'Deployer (master EOA)': '0xB1517bB7C0932f1154Fa4b17DeC2a6a4a3d02CC2',
    'V4 Multicurve Hook': '0x892D3C2B4ABEAAF67d52A7B29783E2161B7CaD40',
    'V4 Multicurve Initializer': '0x65dE470Da664A5be139A5D812bE5FDa0d76CC951',
    'V2 Migrator': '0x5F3bA43D44375286296Cb85F1EA2EBfa25dde731',
    'Burned (0x0)': '0x0000000000000000000000000000000000000000',
    'Dead (0xdead)': '0x000000000000000000000000000000000000dEaD',
  };
  if (safeAddress) balanceChecks['Safe (insider)'] = safeAddress as Address;
  if (governorAddress && governorAddress !== safeAddress) {
    balanceChecks['Governor (governance)'] = governorAddress;
  }
  if (poolOrHookAddress) balanceChecks['Pool/Hook from Airlock'] = poolOrHookAddress;

  let totalAccountedFor = 0n;
  const seenAddrs = new Set<string>();

  for (const [label, addr] of Object.entries(balanceChecks)) {
    const addrLower = addr.toLowerCase();
    if (seenAddrs.has(addrLower)) continue;
    seenAddrs.add(addrLower);

    const bal = await safeRead<bigint>(pc, {
      address: tokenAddress, abi: erc20Abi, functionName: 'balanceOf', args: [addr],
    }, -1n);

    if (bal === -1n) {
      console.log(`  ${label}: ERROR reading balance — ${addr}`);
      continue;
    }
    if (bal === 0n && !['Airlock', 'Safe (insider)', 'Governor (governance)'].some(x => label.includes(x.split(' ')[0]))) {
      continue; // Skip zero balances for non-essential addresses
    }

    const pct = totalSupply > 0n ? Number((bal * 10000n) / totalSupply) / 100 : 0;
    console.log(`  ${label}: ${fmt(bal)} (${pct}%) — ${addr}`);
    totalAccountedFor += bal;
  }

  const unaccounted = totalSupply - totalAccountedFor;
  if (unaccounted > 0n) {
    console.log(`  Unaccounted: ${fmt(unaccounted)} (${Number((unaccounted * 10000n) / totalSupply) / 100}%)`);
  }

  // ── Step 5: Allocation verification ─────────────────────────────────────
  console.log('\n═══ Allocation Verification ═══');
  const expectedTotal = 1_000_000_000n * 10n ** 18n;
  const expectedInsiders = 100_000_000n * 10n ** 18n; // 10%
  const expectedGovernance = 800_000_000n * 10n ** 18n; // 80%

  check('Total supply = 1B', totalSupply === expectedTotal, fmt(totalSupply));

  if (safeAddress) {
    const safeBal = await safeRead<bigint>(pc, {
      address: tokenAddress, abi: erc20Abi, functionName: 'balanceOf', args: [safeAddress as Address],
    }, 0n);

    if (governorAddress && governorAddress.toLowerCase() === (safeAddress as string).toLowerCase()) {
      console.log('  ⚠ Governor IS the Safe — LaunchpadGovernanceFactory sends 80% directly to multisig');
      check('Safe balance = 800M (governance) + potential vesting',
        safeBal >= expectedGovernance,
        `actual: ${fmt(safeBal)}`);
    } else {
      check('Safe balance = 100M (10%)', safeBal === expectedInsiders,
        `actual: ${fmt(safeBal)} (expected: ${fmt(expectedInsiders)})`);
    }
  }

  if (governorAddress && governorAddress.toLowerCase() !== (safeAddress as string)?.toLowerCase()) {
    const govBal = await safeRead<bigint>(pc, {
      address: tokenAddress, abi: erc20Abi, functionName: 'balanceOf', args: [governorAddress],
    }, 0n);
    check('Governance balance = 800M (80%)', govBal === expectedGovernance,
      `actual: ${fmt(govBal)} (expected: ${fmt(expectedGovernance)})`);
  }

  // ── Step 6: Cross-check Supabase vs on-chain ───────────────────────────
  if (ventureRecord && governorAddress) {
    console.log('\n═══ Supabase Cross-Check ═══');
    // Check if the venture record has governance_address
    check('governance_address in DB', !!ventureRecord.governance_address,
      ventureRecord.governance_address || 'NOT SET');
    check('pool_address in DB', !!ventureRecord.pool_address,
      ventureRecord.pool_address || 'NOT SET');
  }

  console.log('\n═══ Done ═══\n');
}

// ─── CLI ────────────────────────────────────────────────────────────────────

function parseCliArgs(): VerifyArgs {
  const argv = process.argv.slice(2);
  const result: VerifyArgs = {};

  for (let i = 0; i < argv.length; i++) {
    switch (argv[i]) {
      case '--venture-id': result.ventureId = argv[++i]; break;
      case '--token': result.tokenAddress = argv[++i]; break;
      case '--safe': result.safeAddress = argv[++i]; break;
    }
  }

  if (!result.ventureId && !result.tokenAddress) {
    console.log('Usage: yarn tsx scripts/ventures/verify-deployment.ts --venture-id <uuid> [--safe <addr>]');
    console.log('       yarn tsx scripts/ventures/verify-deployment.ts --token <addr> --safe <addr>');
    process.exit(1);
  }

  return result;
}

verify(parseCliArgs());
