import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { goldPath } from './substrate-paths';
import type { Manifest } from './types';
import { ManifestSchema } from './types';

const EXCLUDE_DIRS = new Set(['engine']);
const EXCLUDE_PATTERNS: RegExp[] = [
  /^jinn\.db\.bak/,
  /^config\.before/,
  /^config\.json\.pre/,
  /^daemon-/,
  /\.log$/,
  /^run-/,
];

export interface AdoptOptions {
  sourceDir: string;            // path to the existing .jinn-client/ dir
  opName: string;               // "op-a", "op-b", etc.
  role: Manifest['role'];
  shape: Manifest['shape'];
  apiPort: number;
  substrateRoot?: string;
}

async function copyTreeWithExcludes(srcDir: string, dstDir: string): Promise<void> {
  await fs.mkdir(dstDir, { recursive: true });
  const entries = await fs.readdir(srcDir, { withFileTypes: true });
  for (const ent of entries) {
    if (EXCLUDE_DIRS.has(ent.name)) continue;
    if (EXCLUDE_PATTERNS.some((re) => re.test(ent.name))) continue;
    const srcPath = path.join(srcDir, ent.name);
    const dstPath = path.join(dstDir, ent.name);
    if (ent.isDirectory()) {
      await copyTreeWithExcludes(srcPath, dstPath);
    } else if (ent.isFile()) {
      await fs.copyFile(srcPath, dstPath);
      // preserve mode (keystore-password should remain chmod 600)
      const stat = await fs.stat(srcPath);
      await fs.chmod(dstPath, stat.mode);
    }
  }
}

async function readJsonOrNull<T>(p: string): Promise<T | null> {
  try {
    return JSON.parse(await fs.readFile(p, 'utf-8')) as T;
  } catch {
    return null;
  }
}

interface SourceEarningState {
  master_address: string;
  chain: string;
  fleet_agent_id?: string;
  fleet_safe_address?: string;
  fleet_identity_registry?: string;
  fleet_stage?: string;
  services?: Array<{
    agent_address: string;
    safe_address: string;
    service_id: number;
    mech_address?: string;
    staking_address?: string;
    identity_registry_address?: string;
    step?: string;
  }>;
}

interface SourceConfig {
  rpcUrl?: string;
  apiPort?: number;
  joinedSolverNets?: Record<string, unknown>;
}

export async function adoptOperator(opts: AdoptOptions): Promise<void> {
  const gold = goldPath(opts.opName, opts.substrateRoot);
  const goldJinn = path.join(gold, '.jinn-client');

  // 1. Clear any existing gold for this op
  await fs.rm(gold, { recursive: true, force: true });
  await fs.mkdir(goldJinn, { recursive: true });

  // 2. Copy the source dir with excludes
  await copyTreeWithExcludes(opts.sourceDir, goldJinn);

  // 3. Rewrite apiPort in the copied config.json
  const cfgPath = path.join(goldJinn, 'config.json');
  const cfg = await readJsonOrNull<SourceConfig>(cfgPath);
  if (cfg) {
    cfg.apiPort = opts.apiPort;
    await fs.writeFile(cfgPath, JSON.stringify(cfg, null, 2) + '\n');
  }

  // 4. Read earning_state.json to populate manifest
  const statePath = path.join(goldJinn, 'earning', 'earning_state.json');
  const state = await readJsonOrNull<SourceEarningState>(statePath);
  if (!state) {
    throw new Error(`source operator at ${opts.sourceDir} has no earning/earning_state.json`);
  }
  const svc = state.services?.[0];
  if (!svc) {
    throw new Error(
      `source operator at ${opts.sourceDir} has earning_state.json with no services entry — operator may not have reached the service-registration step yet`,
    );
  }

  if (!cfg || !cfg.rpcUrl) {
    throw new Error(
      `source operator at ${opts.sourceDir} has config.json without rpcUrl — cannot derive substrate manifest`,
    );
  }

  // 5. Build manifest
  const manifest: Manifest = {
    substrateVersion: '1',
    createdAt: new Date().toISOString(),
    adoptedFrom: opts.sourceDir,
    name: opts.opName,
    shape: opts.shape,
    role: opts.role,
    network: state.chain === 'base-sepolia' ? 'base-sepolia' : 'base',
    operator: {
      masterAddress: state.master_address,
      fleetAgentId: state.fleet_agent_id ?? null,
      fleetSafeAddress: state.fleet_safe_address ?? null,
      fleetStage: state.fleet_stage ?? null,
      serviceId: svc.service_id,
      serviceStep: svc.step ?? 'unknown',
      agentEoa: svc.agent_address,
      safeAddress: svc.safe_address,
      mechAddress: svc.mech_address ?? '0x0000000000000000000000000000000000000000',
      stakingAddress: svc.staking_address ?? '0x0000000000000000000000000000000000000000',
      identityRegistry: svc.identity_registry_address ?? state.fleet_identity_registry ?? '0x0000000000000000000000000000000000000000',
    },
    config: {
      apiPort: opts.apiPort,
      rpcUrl: cfg.rpcUrl,
      joinedSolverNets: cfg.joinedSolverNets ? Object.keys(cfg.joinedSolverNets) : [],
    },
  };

  // 6. Validate manifest before writing
  ManifestSchema.parse(manifest);

  // 7. Write manifest
  await fs.writeFile(path.join(gold, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
}

async function cliMain(): Promise<void> {
  // Parse --from <dir> --as <name> --role <role> --shape <shape> --apiPort <port>
  // (one set of args; for multiple ops, invoke multiple times)
  const args = process.argv.slice(2);
  const argMap: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith('--')) {
      const key = args[i].slice(2);
      const val = args[i + 1];
      if (!val) { console.error(`missing value for --${key}`); process.exit(2); }
      argMap[key] = val;
      i++;
    }
  }
  const { from, as: opName, role, shape, apiPort } = argMap;
  if (!from || !opName || !role || !shape || !apiPort) {
    console.error('usage: substrate-adopt --from <.jinn-client-dir> --as <op-name> --role <launcher|participant|legacy-backup> --shape <current|pre-fleet> --apiPort <port>');
    process.exit(2);
  }
  await adoptOperator({
    sourceDir: from,
    opName,
    role: role as Manifest['role'],
    shape: shape as Manifest['shape'],
    apiPort: parseInt(apiPort, 10),
  });
  console.log(`adopted ${opName} from ${from}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  cliMain().catch((err) => {
    console.error(err);
    process.exit(2);
  });
}
