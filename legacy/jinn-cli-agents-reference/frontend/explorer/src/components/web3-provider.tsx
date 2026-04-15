'use client'

import { useState, useEffect, useMemo } from 'react'
import { WagmiProvider } from 'wagmi'
import { cookieToInitialState } from 'wagmi'
import { RainbowKitProvider, darkTheme, lightTheme } from '@rainbow-me/rainbowkit'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { wagmiConfig } from '@/lib/vote/wagmi-config'
import { useTheme } from 'next-themes'
import '@rainbow-me/rainbowkit/styles.css'

export function Web3Provider({
  children,
  cookie,
}: {
  children: React.ReactNode
  cookie?: string | null
}) {
  const initialState = useMemo(() => cookieToInitialState(wagmiConfig, cookie), [cookie])
  const [queryClient] = useState(() => new QueryClient())
  const { resolvedTheme } = useTheme()
  // Avoid SSR/client theme mismatch: only apply resolved theme after mount
  const [mounted, setMounted] = useState(false)
  useEffect(() => setMounted(true), [])

  return (
    <WagmiProvider config={wagmiConfig} initialState={initialState}>
      <QueryClientProvider client={queryClient}>
        <RainbowKitProvider
          theme={mounted ? (resolvedTheme === 'dark' ? darkTheme() : lightTheme()) : undefined}
        >
          {children}
        </RainbowKitProvider>
      </QueryClientProvider>
    </WagmiProvider>
  )
}
