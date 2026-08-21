const CONSOLE_JUMPS: Record<string, string> = {
  '/': '/',
  '/overview': '/',
  '/events': '/events',
  '/notifications': '/notifications',
  '/operator/claim-policy': '/operator/claim-policy',
  '/operator/network': '/operator/network',
  '/operator/security': '/operator/security',
  '/operator/posting': '/operator/posting',
};

export function consoleJumpHref(jumpTo: unknown): string | null {
  if (typeof jumpTo !== 'string') return null;
  return CONSOLE_JUMPS[jumpTo] ?? null;
}
