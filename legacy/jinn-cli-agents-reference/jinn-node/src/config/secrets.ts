/**
 * Secrets loaded from .env — never stored in jinn.yaml.
 *
 * API keys, passwords, and other sensitive values that should not be
 * committed to version control. Loaded from process.env (populated
 * by dotenv from .env file).
 */

export interface Secrets {
    /** RPC endpoint URL — often contains embedded API keys (e.g. Alchemy, Infura) */
    rpcUrl?: string;
    /** Bearer token for authenticated RPC proxy (rpc.jinn.network) */
    rpcProxyToken?: string;
    /** Control API authentication key */
    controlApiServiceKey?: string;
    /** Test RPC endpoint URL — same API key concern as rpcUrl */
    testRpcUrl?: string;
    operatePassword?: string;
    geminiApiKey?: string;
    geminiOauthCredentials?: string;
    openaiApiKey?: string;
    githubToken?: string;
    supabaseUrl?: string;
    supabaseServiceRoleKey?: string;
    supabaseServiceAnonKey?: string;
    x402GatewayUrl?: string;
    civitaiApiKey?: string;
    civitaiApiToken?: string;
    civitaiAirWait?: number;
    zoraApiKey?: string;
    moltbookApiKey?: string;
    tenderlyAccessKey?: string;
    tenderlyAccountSlug?: string;
    tenderlyProjectSlug?: string;
    snykToken?: string;
    fundingPrivateKey?: string;
    umamiUsername?: string;
    umamiPassword?: string;
}

/**
 * Load secrets from process.env.
 * These come from .env (via dotenv) or injected by the deployment platform.
 */
export function loadSecrets(): Secrets {
    return {
        rpcUrl: process.env.RPC_URL,
        rpcProxyToken: process.env.RPC_PROXY_TOKEN,
        controlApiServiceKey: process.env.CONTROL_API_SERVICE_KEY,
        testRpcUrl: process.env.TEST_RPC_URL,
        operatePassword: process.env.OPERATE_PASSWORD,
        geminiApiKey: process.env.GEMINI_API_KEY,
        geminiOauthCredentials: process.env.GEMINI_OAUTH_CREDENTIALS,
        openaiApiKey: process.env.OPENAI_API_KEY,
        githubToken: process.env.GITHUB_TOKEN,
        supabaseUrl: process.env.SUPABASE_URL,
        supabaseServiceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY,
        supabaseServiceAnonKey: process.env.SUPABASE_SERVICE_ANON_KEY,
        x402GatewayUrl: process.env.X402_GATEWAY_URL,
        civitaiApiKey: process.env.CIVITAI_API_KEY,
        civitaiApiToken: process.env.CIVITAI_API_TOKEN,
        civitaiAirWait: (() => {
            const raw = process.env.CIVITAI_AIR_WAIT;
            if (!raw) return undefined;
            const n = Number(raw);
            return isNaN(n) ? undefined : n;
        })(),
        zoraApiKey: process.env.ZORA_API_KEY,
        moltbookApiKey: process.env.MOLTBOOK_API_KEY,
        tenderlyAccessKey: process.env.TENDERLY_ACCESS_KEY,
        tenderlyAccountSlug: process.env.TENDERLY_ACCOUNT_SLUG,
        tenderlyProjectSlug: process.env.TENDERLY_PROJECT_SLUG,
        snykToken: process.env.SNYK_TOKEN,
        fundingPrivateKey: process.env.FUNDING_PRIVATE_KEY,
        umamiUsername: process.env.UMAMI_USERNAME,
        umamiPassword: process.env.UMAMI_PASSWORD,
    };
}
