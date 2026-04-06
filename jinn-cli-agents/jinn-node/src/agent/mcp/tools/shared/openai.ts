import { OpenAI } from 'openai';
import { getCredential } from '../../../shared/credential-client.js';

let sharedClient: OpenAI | null = null;

export async function getOpenAIClient(): Promise<OpenAI> {
  if (sharedClient) return sharedClient;
  const apiKey = await getCredential('openai');
  sharedClient = new OpenAI({ apiKey });
  return sharedClient;
}
