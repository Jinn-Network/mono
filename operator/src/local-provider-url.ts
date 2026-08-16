import { isIP } from 'node:net';

export function canonicalLocalHttpBaseUrl(value: string): string | undefined {
  try {
    const url = new URL(value);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined;
    if (url.username || url.password) return undefined;
    if (url.search || url.hash) return undefined;
    const hostname = url.hostname.toLowerCase();
    const isLocal =
      hostname === 'localhost' ||
      hostname === '[::1]' ||
      hostname === '::1' ||
      (isIP(hostname) === 4 && hostname.startsWith('127.'));
    return isLocal ? url.toString() : undefined;
  } catch {
    return undefined;
  }
}

export function isLocalHttpBaseUrl(value: string): boolean {
  return canonicalLocalHttpBaseUrl(value) !== undefined;
}

export function urlAtBasePath(baseUrl: string, path: string): string {
  return new URL(path, baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`).toString();
}
