import { execFile } from 'node:child_process';
import { cpSync, mkdtempSync, rmSync, writeFileSync, copyFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/**
 * The `npm pack` entry list for the client's `/deployments/` allowlist rules, computed against a
 * minimal throwaway copy of the checkout — package.json (lifecycle scripts and
 * bundledDependencies stripped), .npmignore, and the deployments/ tree.
 *
 * Deliberately NOT `npm pack --dry-run` in the live client root (#2641): even a dry-run pack
 * runs the client's prepack/postpack lifecycle, and prepack (materialize-bundled-workspaces)
 * REPLACES the real node_modules/@jinn-network symlinks in place for seconds — every
 * concurrently running suite test that spawns a real tsx child through the checkout then dies
 * with ERR_MODULE_NOT_FOUND mid-window. And a live-root pack without the lifecycle walks the
 * whole symlinked workspace tree (~80k entries, ~47s), timing the caller out. The `files`
 * allowlist and .npmignore are copied verbatim, so npm's inclusion/exclusion semantics — the
 * thing under test — are identical to a real publish's.
 */
export async function packedDeploymentPaths(clientRoot: string): Promise<readonly string[]> {
  const probeRoot = mkdtempSync(join(tmpdir(), 'jinn-pack-probe-'));
  try {
    const manifest = JSON.parse(readFileSync(join(clientRoot, 'package.json'), 'utf8')) as Record<string, unknown>;
    delete manifest['scripts'];
    delete manifest['bundledDependencies'];
    writeFileSync(join(probeRoot, 'package.json'), JSON.stringify(manifest));
    if (existsSync(join(clientRoot, '.npmignore'))) {
      copyFileSync(join(clientRoot, '.npmignore'), join(probeRoot, '.npmignore'));
    }
    cpSync(join(clientRoot, 'deployments'), join(probeRoot, 'deployments'), { recursive: true });
    const { stdout } = await execFileAsync(
      'npm',
      ['pack', '--dry-run', '--ignore-scripts', '--json'],
      { cwd: probeRoot, maxBuffer: 64 * 1024 * 1024 },
    );
    const [entry] = JSON.parse(stdout) as readonly {
      readonly files: readonly { readonly path: string }[];
    }[];
    return entry!.files.map((file) => file.path);
  } finally {
    rmSync(probeRoot, { recursive: true, force: true });
  }
}
