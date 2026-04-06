import * as civitaiPkg from 'civitai';
import { getCredential } from '../../../shared/credential-client.js';

// Minimal SDK loader that works across ESM/CJS variations
let _sdk: any | null = null;
async function getCivitaiSdk(): Promise<any> {
  if (_sdk) return _sdk;
  const apiKey = await getCredential('civitai');

  const candidate: any = civitaiPkg as any;
  let Ctor: any = candidate?.Civitai;
  if (!Ctor && candidate?.default) {
    Ctor = candidate.default.Civitai || candidate.default;
  }
  if (!Ctor) {
    Ctor = candidate; // last resort
  }
  if (typeof Ctor !== 'function') {
    throw new Error('Unable to load Civitai SDK constructor from civitai package');
  }
  _sdk = new Ctor({ auth: apiKey });
  return _sdk;
}

// Public helpers
export async function checkModelAvailability(): Promise<{ available: boolean; error?: string; models?: any[] }> {
  try {
    const sdk = await getCivitaiSdk();
    
    // Temporarily suppress stdout/stderr to prevent MCP protocol corruption
    const originalStdout = process.stdout.write;
    const originalStderr = process.stderr.write;
    
    try {
      // Redirect stdout/stderr to nowhere during SDK calls
      process.stdout.write = () => true;
      process.stderr.write = () => true;
      
      const models = await (sdk as any).models.get({ limit: 1 });
      return { available: true, models: (models as any)?.data ?? [] };
    } finally {
      // Restore stdout/stderr
      process.stdout.write = originalStdout;
      process.stderr.write = originalStderr;
    }
  } catch (error: any) {
    return {
      available: false,
      error: error?.message || String(error),
      models: [],
    };
  }
}

export interface AirCreateImageParams {
  model: string; // AIR URN
  params: {
    prompt: string;
    negativePrompt?: string;
    scheduler?: string;
    steps?: number;
    cfgScale?: number;
    width?: number;
    height?: number;
    seed?: number;
    clipSkip?: number;
    [key: string]: any;
  };
  additionalNetworks?: Record<string, {
    strength?: number;
    triggerWord?: string;
    [key: string]: any;
  }>;
}

export interface AirCreateResponse {
  status?: string;
  images?: Array<{ url?: string } & Record<string, any>>;
  output?: Array<{ url?: string } & Record<string, any>>;
  result?: Array<{ url?: string } & Record<string, any>>;
  url?: string;
  [key: string]: any;
}

export async function airCreateImage(input: AirCreateImageParams): Promise<AirCreateResponse> {
  const sdk = getCivitaiSdk();
  // Default to not using SDK's long-poll to avoid noisy stderr logs in some environments.
  const wait = (process.env.CIVITAI_AIR_WAIT ?? 'false').toLowerCase() !== 'false';
  
  // Temporarily suppress stdout/stderr to prevent MCP protocol corruption
  const originalStdout = process.stdout.write;
  const originalStderr = process.stderr.write;
  
  try {
    // Redirect stdout/stderr to nowhere during SDK calls
    process.stdout.write = () => true;
    process.stderr.write = () => true;
    
    const res = await (sdk as any).image.fromText(input as any, wait);
    return res as AirCreateResponse;
  } finally {
    // Restore stdout/stderr
    process.stdout.write = originalStdout;
    process.stderr.write = originalStderr;
  }
}

export function extractFirstImageUrl(res: AirCreateResponse): string | null {
  const arrays = [res.images, res.output, res.result];
  for (const arr of arrays) {
    if (Array.isArray(arr)) {
      const found = arr.find((x) => x && typeof x.url === 'string');
      if (found?.url) return found.url;
    }
  }
  // SDK sometimes returns jobs with nested results containing blobUrl
  const anyRes: any = res as any;
  if (Array.isArray(anyRes?.jobs)) {
    for (const job of anyRes.jobs) {
      const results = job?.result;
      if (Array.isArray(results)) {
        for (const r of results) {
          if (typeof r?.blobUrl === 'string') return r.blobUrl;
          if (typeof r?.url === 'string') return r.url;
        }
      }
    }
  }
  if (typeof (res as any).url === 'string') return (res as any).url;
  return null;
}

// Quiet manual polling helpers (avoid SDK's internal wait loop logs)
export async function getJobsByToken(token: string): Promise<any> {
  const sdk = getCivitaiSdk();
  
  // Temporarily suppress stdout/stderr to prevent MCP protocol corruption
  const originalStdout = process.stdout.write;
  const originalStderr = process.stderr.write;
  
  try {
    // Redirect stdout/stderr to nowhere during SDK calls
    process.stdout.write = () => true;
    process.stderr.write = () => true;
    
    const res = await (sdk as any).jobs.getByToken(token);
    return res;
  } finally {
    // Restore stdout/stderr
    process.stdout.write = originalStdout;
    process.stderr.write = originalStderr;
  }
}

export async function waitForImageUrlByToken(token: string, timeoutMs = 120_000, intervalMs = 1_500): Promise<string | null> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const jobRes = await getJobsByToken(token);
    const url = extractFirstImageUrl(jobRes as any);
    if (url) return url;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return null;
}

 