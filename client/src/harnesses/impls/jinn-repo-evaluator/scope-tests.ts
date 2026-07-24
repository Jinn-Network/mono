/**
 * Pure changed-file → mirrored-test-path mapping for the jinn-repo live-issue
 * mechanical evaluator (issue #1891).
 *
 * No I/O here — this module only computes *candidate* test paths from a list
 * of repo-root-relative changed file paths. It does NOT check whether those
 * paths actually exist on disk; the caller (`live-eval-runner.ts`, which does
 * do I/O against the throwaway repro clone) filters candidates by existence
 * and falls back to a package's full test script when none exist. That
 * two-step split keeps this module trivially unit-testable while the runner
 * owns the filesystem truth.
 *
 * Mirror convention (docs/runbooks/testing.md): `<pkg>/src/foo/bar.ts` →
 * `<pkg>/test/foo/bar.test.ts`. A file that is already a test file (matches
 * `*.test.ts(x)`) — including co-located tests that live under `src/` (e.g.
 * the dashboard SPA, which does not follow the src↔test split) — is used
 * as-is rather than re-mirrored, so it is never double-suffixed.
 *
 * A changed file outside every known package's root contributes nothing (no
 * test framework is wired up for it here); a changed file inside a package's
 * root but outside both its `src/` and `test/` dirs (e.g. `package.json`)
 * still marks that package as touched, with zero candidate test files — the
 * runner reads that as "fall back to this package's full test script".
 */

export interface PackageSpec {
  /** Repo-root-relative package directory, no trailing slash (e.g. `client`). */
  root: string;
  /** Repo-root-relative source directory (e.g. `client/src`). */
  srcDir: string;
  /** Repo-root-relative test directory (e.g. `client/test`). */
  testDir: string;
  /** `yarn <script>` name run for the FULL typecheck gate (never scoped). */
  typecheckScript: string;
  /** `yarn <script>` name run as the full-suite fallback when no test files are scoped. */
  testScript: string;
}

export interface PackageScope {
  pkg: PackageSpec;
  /**
   * Repo-root-relative candidate mirrored test file paths for this package.
   * May contain paths that do not exist on disk — the runner is responsible
   * for filtering. An empty array (with the package still present in the
   * returned list) means "this package was touched but no test file could be
   * derived — fall back to its full test script".
   */
  candidateTestFiles: string[];
}

/** The two TypeScript packages a jinn-repo live-issue patch can realistically
 *  touch and that this evaluator knows how to gate: `client` (the daemon —
 *  every jinn-repo pool instance mined so far is client/test-scoped, see
 *  `jinn-repo-extract.ts`'s `TEST_PATH` filter) and `packages/sdk` (the
 *  typed SolverNet contract layer `client` portals to). `packages/sdk` is
 *  ordered first: it is a dependency-free leaf package, so grading it before
 *  the heavier `client` gate fails fast on a broken contract surface. */
export const SDK_PACKAGE: PackageSpec = {
  root: 'packages/sdk',
  srcDir: 'packages/sdk/src',
  testDir: 'packages/sdk/test',
  typecheckScript: 'typecheck',
  testScript: 'test',
};

export const CLIENT_PACKAGE: PackageSpec = {
  root: 'client',
  srcDir: 'client/src',
  testDir: 'client/test',
  typecheckScript: 'typecheck',
  testScript: 'test',
};

export const KNOWN_LIVE_EVAL_PACKAGES: readonly PackageSpec[] = [SDK_PACKAGE, CLIENT_PACKAGE];

const TEST_FILE_RE = /\.test\.tsx?$/;
const SOURCE_EXT_RE = /\.tsx?$/;

function ownerPackage(file: string, packages: readonly PackageSpec[]): PackageSpec | undefined {
  return packages.find((p) => file === p.root || file.startsWith(`${p.root}/`));
}

function mirrorSrcToTest(file: string, pkg: PackageSpec): string {
  const relFromSrc = file.slice(pkg.srcDir.length + 1);
  const dot = relFromSrc.lastIndexOf('.');
  const ext = dot >= 0 ? relFromSrc.slice(dot) : '';
  const withoutExt = dot >= 0 ? relFromSrc.slice(0, dot) : relFromSrc;
  const testExt = ext === '.tsx' ? '.test.tsx' : '.test.ts';
  return `${pkg.testDir}/${withoutExt}${testExt}`;
}

/**
 * Groups repo-root-relative changed file paths by owning package and maps
 * each to a candidate test path per the mirror convention above.
 */
export function scopeTestsForChangedFiles(
  changedFiles: string[],
  packages: readonly PackageSpec[] = KNOWN_LIVE_EVAL_PACKAGES,
): PackageScope[] {
  const touched = new Map<PackageSpec, Set<string>>();

  for (const file of changedFiles) {
    const pkg = ownerPackage(file, packages);
    if (!pkg) continue; // outside every known package — nothing to gate here

    if (!touched.has(pkg)) touched.set(pkg, new Set());
    const scoped = touched.get(pkg)!;

    if (TEST_FILE_RE.test(file)) {
      // Already a test file wherever it lives (including co-located src/
      // tests, e.g. the dashboard SPA) — run it directly, never re-mirror.
      scoped.add(file);
    } else if (SOURCE_EXT_RE.test(file) && (file === pkg.srcDir || file.startsWith(`${pkg.srcDir}/`))) {
      scoped.add(mirrorSrcToTest(file, pkg));
    }
    // Else: a package-root file outside src/test (config, package.json, a
    // non-.ts/.tsx source file, …). No candidate test file, but the package
    // stays "touched" via the Map entry created above, so an empty candidate
    // list still triggers the fallback rather than being silently ignored.
  }

  return [...touched.entries()].map(([pkg, files]) => ({
    pkg,
    candidateTestFiles: [...files].sort(),
  }));
}
