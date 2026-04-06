import { getDefaultConfig } from '@rainbow-me/rainbowkit'
import { mainnet } from 'wagmi/chains'
import { cookieStorage, createStorage } from 'wagmi'
import { http } from 'wagmi'

export const wagmiConfig = getDefaultConfig({
  appName: 'Jinn Explorer',
  projectId: process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID || 'placeholder',
  chains: [mainnet],
  transports: {
    [mainnet.id]: http('https://ethereum-rpc.publicnode.com'),
  },
  ssr: true,
  storage: createStorage({
    storage: cookieStorage,
  }),
})
