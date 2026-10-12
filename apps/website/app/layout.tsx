import type { Metadata } from 'next';
import { Instrument_Serif, JetBrains_Mono } from 'next/font/google';
import { Provider } from '@/components/provider';
import { appName, siteUrl } from '@/lib/shared';
import './globals.css';

const instrumentSerif = Instrument_Serif({
  subsets: ['latin'],
  weight: '400',
  style: ['normal', 'italic'],
  variable: '--font-instrument-serif',
  display: 'swap',
});

const jetbrainsMono = JetBrains_Mono({
  subsets: ['latin'],
  variable: '--font-jetbrains-mono',
  display: 'swap',
});

// BRAND.md's canonical line, with "offered" where it says "sold": selling
// records is the direction, and a link preview has no room to say so.
const title = `${appName}: an open protocol and network for work and the data it produces`;
const description =
  'Jinn is an open protocol and network for work and the data it produces: checkable by anyone, findable, and offered straight by whoever holds it.';

export const metadata: Metadata = {
  metadataBase: new URL(siteUrl),
  title: {
    default: title,
    template: `%s | ${appName}`,
  },
  description,
  openGraph: {
    title,
    description,
    url: siteUrl,
    siteName: appName,
    type: 'website',
  },
  twitter: { card: 'summary' },
  icons: {
    icon: [
      {
        url:
          "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 120 120' fill='none'%3E%3Ccircle cx='60' cy='60' r='44' stroke='%237aa7dc' stroke-width='6'/%3E%3Cpath d='M60 22 L97 86 L23 86 Z' stroke='%237aa7dc' stroke-width='6'/%3E%3Cline x1='16' y1='60' x2='104' y2='60' stroke='%237aa7dc' stroke-width='6'/%3E%3C/svg%3E",
        type: 'image/svg+xml',
      },
    ],
  },
};

export default function Layout({ children }: LayoutProps<'/'>) {
  return (
    <html
      lang="en"
      className={`dark ${instrumentSerif.variable} ${jetbrainsMono.variable}`}
      suppressHydrationWarning
    >
      <body className="flex min-h-screen flex-col">
        <Provider>{children}</Provider>
      </body>
    </html>
  );
}
