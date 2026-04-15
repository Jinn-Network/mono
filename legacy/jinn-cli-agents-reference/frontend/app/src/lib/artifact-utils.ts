/** Format timestamp in social media style (e.g., "2 mins ago", "3 hours ago") */
export function formatTimeAgo(timestamp: string | number): string {
  const ts = typeof timestamp === 'string' ? Number(timestamp) * 1000 : Number(timestamp) * 1000;
  const now = Date.now();
  const diff = now - ts;
  const seconds = Math.floor(diff / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);
  const months = Math.floor(days / 30);
  const years = Math.floor(days / 365);

  if (seconds < 60) return 'just now';
  if (minutes < 60) return `${minutes} min${minutes !== 1 ? 's' : ''} ago`;
  if (hours < 24) return `${hours} hour${hours !== 1 ? 's' : ''} ago`;
  if (days < 30) return `${days} day${days !== 1 ? 's' : ''} ago`;
  if (months < 12) return `${months} month${months !== 1 ? 's' : ''} ago`;
  return `${years} year${years !== 1 ? 's' : ''} ago`;
}

/** Fetch IPFS content directly from public gateways (client-safe, no env vars needed) */
export async function fetchIpfsContentClient(cid: string): Promise<string | null> {
  const gateways = ['https://gateway.autonolas.tech/ipfs/', 'https://ipfs.io/ipfs/'];
  for (const gw of gateways) {
    try {
      const resp = await fetch(`${gw}${cid}`, { signal: AbortSignal.timeout(10000) });
      if (!resp.ok) continue;
      const text = await resp.text();
      try {
        const parsed = JSON.parse(text);
        const content = parsed.content || text;
        return typeof content === 'string' ? content : JSON.stringify(content, null, 2);
      } catch {
        return text;
      }
    } catch {
      continue;
    }
  }
  return null;
}
