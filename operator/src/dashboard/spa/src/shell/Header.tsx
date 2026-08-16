import { Link } from 'wouter';
import { Badge } from '../components/ui/badge.js';
import { DebugReportButton } from '../components/DebugReportButton.js';

import type { JSX } from 'react';

export interface HeaderProps {
  network: 'testnet' | 'mainnet';
}

/**
 * Top-of-page chrome. The RPC health pill that used to live here moved into
 * the Node Health card on /overview where the operator can act on a degraded
 * RPC. The master-address pill moved into the Wallet Identity row alongside
 * Agent and Safe — it belongs with the rest of the operator's on-chain
 * identity, not next to the network indicator.
 */
export function Header({ network }: HeaderProps): JSX.Element {
  return (
    <header className="flex items-center justify-between px-6 py-3.5">
      <Link
        href="/overview"
        className="font-serif text-[26px] text-foreground no-underline"
      >
        jinn operator
      </Link>
      <div className="flex items-center gap-3">
        <Badge variant="outline">{network}</Badge>
        <DebugReportButton />
      </div>
    </header>
  );
}
