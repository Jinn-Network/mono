import { useQuery } from '@tanstack/react-query';
import { api } from '../api/client.js';
import { SolverNetsSection } from './configuration/SolverNetsSection.js';
import { NetworkSection } from './configuration/NetworkSection.js';
import { SecuritySection } from './configuration/SecuritySection.js';
import { useHashSection } from './configuration/useHashSection.js';
import { OperatorDataMarket } from './operator/OperatorDataMarket.js';

export interface OperatorPageProps {
  onRestartPending?: () => void;
}

interface BootstrapWithChain {
  chain?: 'base' | 'base-sepolia';
  rpcUrl?: string;
  defaultRpcUrl?: string;
}

export function OperatorPage({ onRestartPending = () => undefined }: OperatorPageProps): JSX.Element {
  const { data } = useQuery<BootstrapWithChain>({
    queryKey: ['bootstrap'],
    queryFn: () => api.getBootstrap() as Promise<BootstrapWithChain>,
    refetchInterval: 1500,
  });

  const hash = useHashSection();
  const hashParts = hash?.split('/') ?? [];
  const expandedSection = hashParts[0];
  // Anything after `solvernets/` is forwarded to the section so a deep-link
  // like `solvernets/<cid>/harness` can auto-expand the matching joined card
  // and focus the harness picker.
  const joinedHashFragment =
    expandedSection === 'solvernets' ? hashParts.slice(1).join('/') || undefined : undefined;

  const chain = data?.chain ?? 'base-sepolia';
  const rpcUrl = data?.rpcUrl ?? '';
  const defaultRpcUrl = data?.defaultRpcUrl ?? (chain === 'base' ? 'https://mainnet.base.org' : 'https://sepolia.base.org');

  return (
    <div
      data-testid="operator-page"
      style={{ padding: '24px', display: 'flex', flexDirection: 'column', gap: '16px' }}
    >
      <SolverNetsSection
        defaultExpanded={expandedSection === 'solvernets' || expandedSection === undefined}
        joinedHashFragment={joinedHashFragment}
        onRestartPending={onRestartPending}
      />
      <OperatorDataMarket
        defaultExpanded={expandedSection === 'data-market'}
        onRestartPending={onRestartPending}
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
