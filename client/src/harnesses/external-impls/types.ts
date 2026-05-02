/**
 * Config types for operator-declared external impls. The loader and
 * future config parsing both consume these. Kept in a self-contained
 * module so daemon config wiring can adopt them without pulling in
 * loader internals.
 *
 * Spec: `spec/2026-05-registry-discovery.md` §4.
 */

export interface ExternalImplEntry {
  /** MUST equal the manifest's `name`. */
  name: string;
  /**
   * Pointer to the manifest source. Reserved for future ipfs:// /
   * https:// fetching; currently the loader expects a local
   * directory path (see `entry`).
   */
  package?: string;
  /**
   * Local path the loader uses to find both `jinn.manifest.json` and
   * the entry module. Typically points to a node_modules directory
   * (e.g. `node_modules/@example/forecaster`).
   */
  entry: string;
  /**
   * Optional operator-pinned version. When set, the loader rejects
   * the impl if `manifest.version` does not match this string exactly.
   * Lets operators pin a specific package version in config without
   * relying on `node_modules/` discipline.
   */
  version?: string;
}

export interface SignerTrust {
  alg: 'ed25519';
  publicKey: string;
  label?: string;
}

export interface HarnessesConfig {
  /** Names of in-repo or external impls to suppress for this fleet. */
  disabled?: readonly string[];
  /** Operator-supplied external impls. */
  externalImpls?: readonly ExternalImplEntry[];
}
