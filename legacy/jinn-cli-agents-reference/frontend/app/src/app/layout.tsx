import type { Metadata } from 'next';
import { Inter } from 'next/font/google';
import Script from 'next/script';
import './globals.css';
import { Providers } from '@/components/providers';
import { NavHeader } from '@/components/nav-header';

const inter = Inter({
  variable: '--font-inter',
  subsets: ['latin'],
});

const isDev = process.env.VERCEL_ENV !== 'production';

export const metadata: Metadata = {
  metadataBase: new URL('https://app.jinn.network'),
  title: {
    default: 'Jinn',
    template: '%s | Jinn',
  },
  description: 'Turn what you know into an AI agent that works for you.',
  icons: {
    icon: isDev ? '/favicon-dev.svg' : '/favicon-prod.png',
  },
  openGraph: {
    siteName: 'Jinn',
    images: [{ url: '/og-default.png', width: 1200, height: 630 }],
  },
  twitter: {
    card: 'summary_large_image',
    images: ['/og-default.png'],
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body className={`${inter.variable} antialiased`}>
        <Script
          src="https://umami-production-ae2b.up.railway.app/script.js"
          data-website-id="748fefe3-aa39-4f01-b4e4-70ccd27ecc30"
          strategy="afterInteractive"
        />
        <Providers>
          <NavHeader />
          <main className="min-h-screen bg-background">
            {children}
          </main>
        </Providers>
      </body>
    </html>
  );
}
