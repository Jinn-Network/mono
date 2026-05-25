import { TwitterApi } from 'twitter-api-v2';
import type { Poster } from './poster.js';
import type { BroadcastEvent } from '../types.js';

export interface XCredentials {
  appKey: string;
  appSecret: string;
  accessToken: string;
  accessSecret: string;
}

export class MissingXCredentialsError extends Error {
  constructor(missing: string[]) {
    super(
      `X poster is missing required environment variables: ${missing.join(', ')}. ` +
        `Set X_API_KEY, X_API_SECRET, X_ACCESS_TOKEN, X_ACCESS_TOKEN_SECRET ` +
        `(create an X dev app and a user access token at developer.x.com).`,
    );
    this.name = 'MissingXCredentialsError';
  }
}

export function loadXCredentialsFromEnv(env = process.env): XCredentials {
  const fields = {
    appKey: env['X_API_KEY'],
    appSecret: env['X_API_SECRET'],
    accessToken: env['X_ACCESS_TOKEN'],
    accessSecret: env['X_ACCESS_TOKEN_SECRET'],
  };
  const missing: string[] = [];
  if (!fields.appKey) missing.push('X_API_KEY');
  if (!fields.appSecret) missing.push('X_API_SECRET');
  if (!fields.accessToken) missing.push('X_ACCESS_TOKEN');
  if (!fields.accessSecret) missing.push('X_ACCESS_TOKEN_SECRET');
  if (missing.length) throw new MissingXCredentialsError(missing);
  return fields as XCredentials;
}

export class XPoster implements Poster {
  private readonly client: TwitterApi;

  constructor(creds: XCredentials) {
    this.client = new TwitterApi(creds);
  }

  async post(_event: BroadcastEvent, text: string): Promise<void> {
    await this.client.v2.tweet(text);
  }
}
