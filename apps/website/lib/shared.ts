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
   * The single call to action on every outward surface, per GROWTH.md §3,
   * until the v0 gate produces a result. There is exactly one of these on
   * the landing page; adding a second is a GROWTH.md amendment, not a UI
   * change.
   */
  telegram: 'https://t.me/jinnNetwork',
  explorer: 'https://explorer.jinn.network',
  github: 'https://github.com/Jinn-Network/mono',
  discussions: 'https://github.com/Jinn-Network/mono/discussions',
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
