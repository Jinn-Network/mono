import { useQuery } from '@tanstack/react-query';
import { api } from '../api/client.js';
import { SolverNetsSection } from './configuration/SolverNetsSection.js';
import { NetworkSection } from './configuration/NetworkSection.js';
import { SecuritySection } from './configuration/SecuritySection.js';
import { HarnessSection } from './configuration/HarnessSection.js';
import { useHashSection } from './configuration/useHashSection.js';
import type { NetCardConfig } from './configuration/NetCard.js';

export interface ConfigurationPageProps {
  onRestartPending?: () => void;
}

interface BootstrapWithChainAndSolverNets {
  chain?: 'base' | 'base-sepolia';
  /** Stored config from disk; fields may be missing on legacy / third-party
   *  shapes. SolverNetsSection's resolveConfig merges in defaults. */
  solverNets?: Record<string, Partial<NetCardConfig>>;
  rpcUrl?: string;
  defaultRpcUrl?: string;
  harness?: {
    mode: 'train' | 'frozen';
  };
}

export function ConfigurationPage({ onRestartPending = () => undefined }: ConfigurationPageProps): JSX.Element {
  const { data, refetch } = useQuery<BootstrapWithChainAndSolverNets>({
    queryKey: ['bootstrap'],
    queryFn: () => api.getBootstrap() as Promise<BootstrapWithChainAndSolverNets>,
    refetchInterval: 1500,
  });

  const hash = useHashSection();
  const expandedSection = hash?.split('/')[0];

  const chain = data?.chain ?? 'base-sepolia';
  const rpcUrl = data?.rpcUrl ?? '';
  const defaultRpcUrl = data?.defaultRpcUrl ?? (chain === 'base' ? 'https://mainnet.base.org' : 'https://sepolia.base.org');
  const harnessMode = data?.harness?.mode ?? 'train';

  return (
    <div style={{ padding: '24px', display: 'flex', flexDirection: 'column', gap: '16px' }}>
      <SolverNetsSection
        configByName={data?.solverNets ?? {}}
        onSaved={() => { void refetch(); }}
        onRestartPending={onRestartPending}
        defaultExpanded={expandedSection === 'solvernets' || expandedSection === undefined}
      />
      <HarnessSection
        mode={harnessMode}
        onRestartPending={onRestartPending}
        defaultExpanded={expandedSection === 'harness'}
      />
      <NetworkSection
        chain={chain}
        rpcUrl={rpcUrl}
        defaultRpcUrl={defaultRpcUrl}
        rpcHealthy={true}
        onRestartPending={onRestartPending}
        defaultExpanded={expandedSection === 'network'}
      />
      <SecuritySection defaultExpanded={expandedSection === 'security'} />
    </div>
  );
}
