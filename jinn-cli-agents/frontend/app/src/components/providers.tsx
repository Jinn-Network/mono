'use client';

import { useState } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { PrivyProvider } from '@privy-io/react-auth';
import { WagmiProvider, type Config } from 'wagmi';
import { ThemeProvider } from 'next-themes';
import { Toaster } from 'sonner';
import { wagmiConfig } from '@/lib/wagmi-config';
import { base } from 'viem/chains';

const PRIVY_APP_ID_FALLBACK = '0000000000000000000000000';
const PRIVY_APP_ID_LENGTH = 25;

function resolvePrivyAppId(): string {
  const configuredAppId = process.env.NEXT_PUBLIC_PRIVY_APP_ID?.trim();
  if (configuredAppId && configuredAppId.length === PRIVY_APP_ID_LENGTH) {
    return configuredAppId;
  }

  if (typeof window === 'undefined') {
    console.warn(
      'NEXT_PUBLIC_PRIVY_APP_ID is missing or invalid. Falling back to a placeholder app ID for build-time rendering.'
    );
  }

  return PRIVY_APP_ID_FALLBACK;
}

export function Providers({ children }: { children: React.ReactNode }) {
  const [queryClient] = useState(() => new QueryClient());
  const privyAppId = resolvePrivyAppId();

  return (
    <PrivyProvider
      appId={privyAppId}
      config={{
        defaultChain: base,
        supportedChains: [base],
        appearance: {
          theme: 'dark',
          accentColor: '#3b82f6',
        },
        loginMethods: ['email', 'wallet', 'google'],
        embeddedWallets: {
          ethereum: {
            createOnLogin: 'users-without-wallets',
          },
        },
      }}
    >
      <WagmiProvider config={wagmiConfig as unknown as Config}>
        <QueryClientProvider client={queryClient}>
          <ThemeProvider
            attribute="class"
            defaultTheme="dark"
            enableSystem={false}
            forcedTheme="dark"
            disableTransitionOnChange
          >
            {children}
            <Toaster position="bottom-right" theme="dark" />
          </ThemeProvider>
        </QueryClientProvider>
      </WagmiProvider>
    </PrivyProvider>
  );
}
