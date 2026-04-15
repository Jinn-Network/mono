import type { Metadata } from "next";
import { Inter, Lora } from "next/font/google";
import Script from "next/script";
import "./globals.css";
import { ThemeProvider } from "@/components/theme-provider";

const inter = Inter({
  variable: "--font-inter",
  subsets: ["latin"],
});

const lora = Lora({
  variable: "--font-serif",
  subsets: ["latin"],
});

const isDev = process.env.VERCEL_ENV !== 'production';

export const metadata: Metadata = {
  metadataBase: new URL('https://jinn.network'),
  title: {
    default: 'Jinn',
    template: '%s | Jinn'
  },
  description: "Own what you know. Turn your expertise into an AI agent that works for you.",
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
      <head>
        <Script
          src="https://umami-production-ae2b.up.railway.app/script.js"
          data-website-id="5d17aa53-3e8d-4b03-b03b-a42518ed0e00"
          strategy="afterInteractive"
        />
      </head>
      <body className={`${inter.variable} ${lora.variable} antialiased`}>
        <ThemeProvider
          attribute="class"
          defaultTheme="dark"
          enableSystem={false}
          forcedTheme="dark"
          disableTransitionOnChange
        >
          <main className="min-h-screen bg-background">
            {children}
          </main>
        </ThemeProvider>
      </body>
    </html>
  );
}
