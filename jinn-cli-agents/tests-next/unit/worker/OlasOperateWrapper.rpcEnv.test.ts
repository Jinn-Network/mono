import { afterEach, describe, expect, it } from 'vitest';

import { OlasOperateWrapper } from 'jinn-node/worker/OlasOperateWrapper.js';

type WrapperLike = {
  rpcUrl: string | null;
  config: {
    defaultEnv?: {
      chainLedgerRpc?: Record<string, string>;
    };
  };
  _buildRpcAliasEnv: () => Record<string, string>;
  _buildDefaultEnv: () => Record<string, string>;
  _getRpcAliasLogKeys: (env: Record<string, string>) => string[];
};

function createWrapperLike(params: {
  rpcUrl: string | null;
  chainLedgerRpc?: Record<string, string>;
}): WrapperLike {
  const wrapper = Object.create(OlasOperateWrapper.prototype) as WrapperLike;
  wrapper.rpcUrl = params.rpcUrl;
  wrapper.config = {
    defaultEnv: params.chainLedgerRpc ? { chainLedgerRpc: params.chainLedgerRpc } : {},
  };
  return wrapper;
}

describe('OlasOperateWrapper RPC aliasing', () => {
  const originalRpcUrl = process.env.RPC_URL;

  afterEach(() => {
    if (originalRpcUrl === undefined) {
      delete process.env.RPC_URL;
    } else {
      process.env.RPC_URL = originalRpcUrl;
    }
  });

  it('creates full alias map from wrapper rpcUrl', () => {
    const wrapper = createWrapperLike({
      rpcUrl: 'https://rpc.example',
    });

    const env = wrapper._buildRpcAliasEnv();

    expect(env.RPC_URL).toBe('https://rpc.example');
    expect(env.CUSTOM_CHAIN_RPC).toBe('https://rpc.example');
    expect(env.BASE_CHAIN_RPC).toBe('https://rpc.example');
    expect(env.BASE_LEDGER_RPC).toBe('https://rpc.example');
    expect(env.BASE_RPC).toBe('https://rpc.example');
    expect(env.GNOSIS_CHAIN_RPC).toBe('https://rpc.example');
    expect(env.GNOSIS_LEDGER_RPC).toBe('https://rpc.example');
  });

  it('falls back to process.env.RPC_URL when wrapper rpcUrl is not set', () => {
    process.env.RPC_URL = 'https://env-rpc.example';
    const wrapper = createWrapperLike({ rpcUrl: null });

    const env = wrapper._buildRpcAliasEnv();

    expect(env.RPC_URL).toBe('https://env-rpc.example');
    expect(env.BASE_CHAIN_RPC).toBe('https://env-rpc.example');
  });

  it('preserves chain-specific override values when provided', () => {
    const wrapper = createWrapperLike({
      rpcUrl: 'https://default-rpc.example',
      chainLedgerRpc: {
        gnosis: 'https://gnosis-rpc.example',
        'arbitrum-one': 'https://arb-rpc.example',
      },
    });

    const env = wrapper._buildRpcAliasEnv();

    expect(env.RPC_URL).toBe('https://default-rpc.example');
    expect(env.GNOSIS_CHAIN_RPC).toBe('https://gnosis-rpc.example');
    expect(env.GNOSIS_LEDGER_RPC).toBe('https://gnosis-rpc.example');
    expect(env.ARBITRUM_ONE_CHAIN_RPC).toBe('https://arb-rpc.example');
    expect(env.BASE_CHAIN_RPC).toBe('https://default-rpc.example');
  });

  it('preserves non-enumerated chain override keys', () => {
    const wrapper = createWrapperLike({
      rpcUrl: 'https://default-rpc.example',
      chainLedgerRpc: {
        avalanche: 'https://avax-rpc.example',
      },
    });

    const env = wrapper._buildRpcAliasEnv();

    expect(env.AVALANCHE_RPC).toBe('https://avax-rpc.example');
    expect(env.AVALANCHE_LEDGER_RPC).toBe('https://avax-rpc.example');
    expect(env.AVALANCHE_CHAIN_RPC).toBe('https://avax-rpc.example');
  });

  it('logs only alias key names and never RPC URL values', () => {
    const wrapper = createWrapperLike({
      rpcUrl: 'https://default-rpc.example/very/secret/path?token=abc123',
    });
    const env = wrapper._buildRpcAliasEnv();

    const keys = wrapper._getRpcAliasLogKeys(env);

    expect(keys).toContain('RPC_URL');
    expect(keys).toContain('BASE_CHAIN_RPC');
    expect(keys.some((k) => k.includes('abc123'))).toBe(false);
    expect(keys.some((k) => k.includes('https://'))).toBe(false);
  });

  it('injects RPC aliases into default command env', () => {
    const wrapper = createWrapperLike({
      rpcUrl: 'https://default-rpc.example',
    }) as unknown as {
      config: {
        defaultEnv?: {
          attended?: boolean;
          operatePassword?: string;
          stakingProgram?: 'no_staking' | 'custom_staking';
          chainLedgerRpc?: Record<string, string>;
        };
      };
      _buildDefaultEnv: () => Record<string, string>;
    };

    wrapper.config.defaultEnv = {
      attended: true,
      operatePassword: 'test-password',
      stakingProgram: 'custom_staking',
    };

    const env = wrapper._buildDefaultEnv();

    expect(env.ATTENDED).toBe('true');
    expect(env.OPERATE_PASSWORD).toBe('test-password');
    expect(env.STAKING_PROGRAM).toBe('custom_staking');
    expect(env.RPC_URL).toBe('https://default-rpc.example');
    expect(env.BASE_CHAIN_RPC).toBe('https://default-rpc.example');
  });
});
