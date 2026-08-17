'use client';

import { useEffect, useState } from 'react';

import { IncompatibleContract } from '@/components/IncompatibleContract';
import { Shell } from '@/components/Shell';
import {
  handshakeWithDaemon,
  type HandshakeResult,
} from '@/lib/handshake';

export function HandshakeGate({ children }: { children: React.ReactNode }) {
  const [result, setResult] = useState<HandshakeResult | null>(null);

  useEffect(() => {
    let cancelled = false;
    void handshakeWithDaemon().then((next) => {
      if (!cancelled) setResult(next);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  if (result === null) {
    return (
      <p data-testid="handshake-loading" className="p-6 font-mono text-[13px] text-muted-foreground">
        Loading
      </p>
    );
  }

  if (result.status === 'incompatible') {
    return <IncompatibleContract verdict={result} />;
  }

  if (result.status === 'unreachable' || result.status === 'invalid') {
    return (
      <main data-testid="handshake-error" className="p-6 font-mono text-[14px]">
        Status unavailable
      </main>
    );
  }

  const warn =
    result.status === 'warn'
      ? `Daemon contract ${result.server.major}.${result.server.minor} differs in minor from this console.`
      : undefined;

  return <Shell warn={warn}>{children}</Shell>;
}
