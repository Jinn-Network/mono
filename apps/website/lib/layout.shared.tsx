import type { BaseLayoutProps } from 'fumadocs-ui/layouts/shared';
import { JinnWordmark } from '@/components/jinn-mark';
import { links } from './shared';

export function baseOptions(): BaseLayoutProps {
  return {
    nav: {
      title: <JinnWordmark />,
      transparentMode: 'none',
    },
    githubUrl: links.github,
    // Dark only (WEBSITE-APP-SPEC.md §3.3). The switcher is off, not hidden.
    themeSwitch: { enabled: false },
    links: [
      { text: 'Docs', url: '/docs', active: 'nested-url' },
      { text: 'Protocol', url: links.spec, external: true },
      { text: 'Colophon', url: links.colophon, external: true },
    ],
  };
}
