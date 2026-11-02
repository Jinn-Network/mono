export const appName = 'Jinn';
export const siteUrl = 'https://jinn.network';
export const docsRoute = '/docs';

/**
 * Every outbound destination the site links to, in one place. A page that
 * hard-codes an external URL instead of importing from here is a page the
 * link checker cannot reason about.
 */
export const links = {
  /**
   * The single call to action on every outward surface, per GROWTH.md §3:
   * "Bring a claim". It points at the part of Colophon's site that says how a
   * claim is brought today. There is exactly one of these on the landing
   * page; a second ask is a GROWTH.md amendment, not a UI change.
   */
  bringAClaim: 'https://colophon.claims/#publish',
  /** Colophon, the first application built on Jinn. */
  colophon: 'https://colophon.claims/',
  colophonFind: 'https://colophon.claims/find/',
  colophonLimits: 'https://colophon.claims/docs/#limits',
  /** The protocol. It is written only in this repository. */
  spec: 'https://github.com/Jinn-Network/spec',
  specRelease: 'https://github.com/Jinn-Network/spec/releases/tag/v0.1.0',
  specOpenQuestions: 'https://github.com/Jinn-Network/spec#what-is-not-yet-proven',
  /** Jinn's published checker. */
  verifier: 'https://www.npmjs.com/package/@jinn-network/verify',
  /**
   * The record of what ran on the parked Base Sepolia network. Every link to
   * it says so in its own words; it is never offered as a live network.
   */
  explorer: 'https://explorer.jinn.network',
  github: 'https://github.com/Jinn-Network/mono',
} as const;

export const gitConfig = {
  user: 'Jinn-Network',
  repo: 'mono',
  branch: 'next',
} as const;

/** Repository paths this site links out to rather than mirroring. */
export function repoFile(path: string): string {
  return `https://github.com/${gitConfig.user}/${gitConfig.repo}/blob/${gitConfig.branch}/${path}`;
}
