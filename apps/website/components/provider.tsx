'use client';

import { RootProvider } from 'fumadocs-ui/provider/next';
import type { ReactNode } from 'react';
import SearchDialog from '@/components/search';

/**
 * Dark-only. The design system is dark-first ("the protocol lives in a deep
 * blue night") and shipping one narrative keeps the three CSS layers from
 * needing two reconciliations instead of one. The theme switcher is off, not
 * hidden.
 */
export function Provider({ children }: { children: ReactNode }) {
  return (
    <RootProvider
      theme={{ enabled: false, forcedTheme: 'dark' }}
      search={{ SearchDialog }}
    >
      {children}
    </RootProvider>
  );
}
