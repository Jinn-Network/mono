/**
 * Shared GitHub HTTP client. Uses GITHUB_TOKEN if present (so the bot can run
 * inside Actions without extra config), falls back to unauthenticated which
 * works for public repos but is rate-limited to 60/hour.
 */
export interface GithubClient {
  rest(path: string): Promise<unknown>;
  graphql<T>(query: string, variables: Record<string, unknown>): Promise<T>;
}

export function makeGithubClient(token = process.env['GITHUB_TOKEN']): GithubClient {
  const headers: Record<string, string> = {
    accept: 'application/vnd.github+json',
    'x-github-api-version': '2022-11-28',
    'user-agent': 'jinn-broadcast-bot',
  };
  if (token) headers['authorization'] = `Bearer ${token}`;

  return {
    async rest(path: string) {
      const url = path.startsWith('http') ? path : `https://api.github.com${path}`;
      const res = await fetch(url, { headers });
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new Error(`GitHub REST ${url} failed ${res.status}: ${body.slice(0, 200)}`);
      }
      return res.json();
    },
    async graphql<T>(query: string, variables: Record<string, unknown>): Promise<T> {
      const res = await fetch('https://api.github.com/graphql', {
        method: 'POST',
        headers: { ...headers, 'content-type': 'application/json' },
        body: JSON.stringify({ query, variables }),
      });
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new Error(`GitHub GraphQL failed ${res.status}: ${body.slice(0, 200)}`);
      }
      const json = (await res.json()) as { data?: T; errors?: Array<{ message: string }> };
      if (json.errors?.length) {
        throw new Error(`GitHub GraphQL errors: ${json.errors.map((e) => e.message).join('; ')}`);
      }
      return json.data as T;
    },
  };
}
