export const DEFAULT_OPERATOR_URL = 'http://127.0.0.1:7331';
export const UI_TOKEN_HEADER = 'x-jinn-ui-token';
export const UI_TOKEN_STORAGE_KEY = 'jinn-ui-token';

export function operatorUrl(): string {
  if (typeof process !== 'undefined') {
    const fromPublic = process.env.NEXT_PUBLIC_JINN_OPERATOR_URL;
    const fromEnv = process.env.JINN_OPERATOR_URL;
    if (fromPublic && fromPublic.length > 0) return fromPublic.replace(/\/$/, '');
    if (fromEnv && fromEnv.length > 0) return fromEnv.replace(/\/$/, '');
  }
  return DEFAULT_OPERATOR_URL;
}

export function readUiToken(): string | undefined {
  if (typeof window !== 'undefined') {
    const stored = window.sessionStorage.getItem(UI_TOKEN_STORAGE_KEY);
    if (stored && stored.length > 0) return stored;
  }
  const fromEnv = process.env.NEXT_PUBLIC_JINN_UI_TOKEN;
  if (fromEnv && fromEnv.length > 0) return fromEnv;
  return undefined;
}

export function writeUiToken(token: string): void {
  if (typeof window === 'undefined') return;
  window.sessionStorage.setItem(UI_TOKEN_STORAGE_KEY, token);
}

export function clearUiToken(): void {
  if (typeof window === 'undefined') return;
  window.sessionStorage.removeItem(UI_TOKEN_STORAGE_KEY);
}

export type DaemonFetchInit = Omit<RequestInit, 'credentials'>;

/**
 * Browser → daemon fetch. Header token only; never cookies
 * (`credentials` is always `omit` — headless §9).
 */
export async function daemonFetch(
  path: string,
  init: DaemonFetchInit = {},
): Promise<Response> {
  const headers = new Headers(init.headers);
  const token = readUiToken();
  if (token) headers.set(UI_TOKEN_HEADER, token);
  if (!headers.has('Accept')) headers.set('Accept', 'application/json');
  const url = path.startsWith('http') ? path : `${operatorUrl()}${path}`;
  return fetch(url, { ...init, headers, credentials: 'omit' });
}

export async function daemonJson<T>(
  path: string,
  init: DaemonFetchInit = {},
): Promise<T> {
  const response = await daemonFetch(path, init);
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(text || `daemon ${response.status}`);
  }
  return (await response.json()) as T;
}
