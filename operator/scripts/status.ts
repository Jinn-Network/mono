#!/usr/bin/env node
/**
 * Operator status: GET /v1/status from the local daemon API, or partial off-chain
 * fleet summary when the API is unreachable.
 *
 * Uses the same config resolution as the daemon (file > env > defaults).
 *
 * Usage:
 *   yarn status
 *   yarn status -- --config ./my-config.json
 */

import { config as dotenvConfig } from 'dotenv';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig, getConfigPathFromArgs } from '../src/config.js';
import { FleetStateStore } from '../src/earning/store.js';
import type { StatusV1Response } from '../src/api/status-build.js';
import { resolveUiToken } from '../src/cli/daemon-control-client.js';

dotenvConfig({ path: join(dirname(fileURLToPath(import.meta.url)), '..', '.env') });

function printHumanSummary(body: StatusV1Response): void {
  const d = body.daemon;
  const r = body.rpc;
  const f = body.fleet;
  const m = body.masterGas;
  const rw = body.rewards;

  console.log(`Jinn status  ${d.timestamp}`);
  console.log(`  mode:       ${body.statusMode}`);
  console.log(`  daemon DB:  ${d.dbPath}`);
  console.log(`  shutdown:   ${d.shutdownState ?? '(unknown)'}`);

  if (r.ok) {
    console.log(`  RPC:        ok  chainId=${r.chainId}  block=${r.blockNumber}`);
  } else {
    console.log(`  RPC:        failed${r.error ? ` — ${r.error}` : ''}`);
  }

  if (f.loaded) {
    console.log(
      `  fleet:      ${f.completeCount}/${f.services.length} complete, ${f.stakedLikeCount} staked-like  (chain=${f.chain}, mode=${f.stakingMode})`,
    );
    if (f.masterAddress) {
      console.log(`  master:     ${f.masterAddress}`);
    }
    for (const s of f.services) {
      console.log(
        `    service ${s.index}: step=${s.step}  id=${s.serviceId ?? '—'}  safe=${s.safeAddress ?? '—'}`,
      );
    }
  } else {
    console.log('  fleet:      (no earning_state.json or unreadable)');
  }

  if (m.balanceWei !== undefined) {
    console.log(`  master ETH: ${m.balanceWei} wei (min hint ${m.minEthWei ?? '—'} wei)`);
  } else if (m.address) {
    console.log(`  master ETH: (unreadable${m.error ? `: ${m.error}` : ''})`);
  }
  console.log(`  gas est.:   ${m.dailyEstimateWei} wei/day`);
  if (m.runwayDaysExcess !== undefined) {
    console.log(`  runway:     ~${m.runwayDaysExcess} day(s) excess vs min (very rough)`);
  }

  console.log(`  rewards:    interval ${rw.claimLoopIntervalMs} ms  lastTick=${rw.lastClaimTickAt ?? 'never'}`);
  // The OLAS staking collector queue is no longer carried on /v1/status (#992);
  // run `jinn rewards` for the on-demand pending total.

  const counts = body.activity.counts;
  const c = Object.keys(counts).length ? JSON.stringify(counts) : '{}';
  console.log(`  activity:   counts ${c}`);
  if (body.activity.recent.length > 0) {
    console.log('  recent:');
    for (const row of body.activity.recent.slice(0, 8)) {
      console.log(`    ${row.kind}  ${row.requestId}`);
    }
  }

  console.log(`  earnings:   ${body.earnings.hint}`);
  console.log('  next:');
  for (const line of body.nextActions) {
    console.log(`    — ${line}`);
  }
}

async function printOfflineFleetSummary(earningDir: string): Promise<void> {
  const store = new FleetStateStore(earningDir);
  const fleet = await store.tryLoadExisting();
  if (!fleet) {
    console.log(`No fleet state at ${earningDir}/earning_state.json`);
    return;
  }
  console.log('Daemon API unreachable — off-chain fleet snapshot only:');
  console.log(`  chain: ${fleet.chain}  staking: ${fleet.staking_mode}`);
  console.log(`  master: ${fleet.master_address ?? '—'}`);
  for (const s of fleet.services) {
    console.log(`  service ${s.index}: ${s.step}  id=${s.service_id ?? '—'}`);
  }
  console.log('Start the daemon (yarn jinn run) or fix JINN_API_PORT / firewall for full status.');
}

async function main(): Promise<void> {
  const config = loadConfig(getConfigPathFromArgs());
  const url = `http://127.0.0.1:${config.apiPort}/v1/status`;
  // `/v1/status` is operator-class as of spec §14.5 (issue #2404) — send the
  // on-disk UI token via the same resolver the CLI's control client and
  // introspection-context.ts use (cli/daemon-control-client.ts).
  const token = resolveUiToken();

  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(8000),
      headers: token ? { 'x-jinn-ui-token': token } : {},
    });
    if (!res.ok) {
      const text = await res.text();
      console.error(`HTTP ${res.status} from ${url}`);
      console.error(text);
      await printOfflineFleetSummary(config.earningDir);
      process.exitCode = 1;
      return;
    }
    const body = (await res.json()) as StatusV1Response;
    printHumanSummary(body);
  } catch {
    console.error(`Could not reach ${url}`);
    await printOfflineFleetSummary(config.earningDir);
    process.exitCode = 1;
  }
}

main();
