'use client';

import type { HandshakeVerdict } from '@/lib/handshake';

export function IncompatibleContract({
  verdict,
}: {
  verdict: Extract<HandshakeVerdict, { status: 'incompatible' }>;
}) {
  return (
    <main
      data-testid="incompatible-contract"
      className="flex min-h-screen flex-col items-center justify-center gap-4 bg-sunken px-6 text-center"
    >
      <h1 className="font-[family-name:var(--font-display)] text-[48px] font-normal text-foreground">
        Contract mismatch
      </h1>
      <p className="m-0 font-mono text-[14px] text-muted-foreground">
        Daemon {verdict.server.major}.{verdict.server.minor} · console{' '}
        {verdict.console.major}.{verdict.console.minor}
      </p>
    </main>
  );
}
