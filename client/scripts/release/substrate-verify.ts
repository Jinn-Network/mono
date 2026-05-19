import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { ManifestSchema, type Manifest, type VerifyResult } from './types';
import { goldPath } from './substrate-paths';

export interface VerifyOptions {
  substrateRoot?: string;
  skipOnChain?: boolean;
}

export async function verifySubstrate(opName: string, opts: VerifyOptions = {}): Promise<VerifyResult> {
  const failures: string[] = [];
  const warnings: string[] = [];

  const opDir = goldPath(opName, opts.substrateRoot);
  const manifestPath = path.join(opDir, 'manifest.json');

  // 1. Manifest exists
  let manifestRaw: string;
  try {
    manifestRaw = await fs.readFile(manifestPath, 'utf-8');
  } catch (err) {
    failures.push(`manifest.json not found at ${manifestPath}`);
    return { opName, ok: false, failures, warnings, onChain: null };
  }

  // 2. Manifest parses
  let manifestJson: unknown;
  try {
    manifestJson = JSON.parse(manifestRaw);
  } catch (err) {
    failures.push(`manifest.json is not valid JSON: ${(err as Error).message}`);
    return { opName, ok: false, failures, warnings, onChain: null };
  }

  // 3. Manifest validates against schema
  const parseResult = ManifestSchema.safeParse(manifestJson);
  if (!parseResult.success) {
    failures.push(`manifest.json failed schema validation: ${parseResult.error.message}`);
    return { opName, ok: false, failures, warnings, onChain: null };
  }
  const manifest: Manifest = parseResult.data;

  // 4. Name in manifest matches the op being verified
  if (manifest.name !== opName) {
    failures.push(`manifest.name=${manifest.name} does not match expected opName=${opName}`);
  }

  // 5. On-chain check (skip for now if requested)
  if (opts.skipOnChain) {
    return { opName, ok: failures.length === 0, failures, warnings, onChain: null };
  }

  // On-chain check implementation lands in Task 5
  warnings.push('on-chain check not yet implemented; skipping');
  return { opName, ok: failures.length === 0, failures, warnings, onChain: null };
}

async function cliMain(): Promise<void> {
  const opName = process.argv[2];
  if (!opName) {
    console.error('usage: substrate-verify <op-name> [--skip-on-chain]');
    process.exit(2);
  }
  const skipOnChain = process.argv.includes('--skip-on-chain');
  const result = await verifySubstrate(opName, { skipOnChain });
  console.log(JSON.stringify(result, null, 2));
  process.exit(result.ok ? 0 : 1);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  cliMain().catch((err) => {
    console.error(err);
    process.exit(2);
  });
}
