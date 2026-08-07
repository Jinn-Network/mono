import type { Metadata } from "next";
import "./globals.css";
import { PRODUCT_BRANDING } from "@/lib/branding";

export const metadata: Metadata = {
  title: PRODUCT_BRANDING.displayName,
  description: PRODUCT_BRANDING.tagline,
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen bg-background font-sans text-foreground antialiased">
        {children}
      </body>
    </html>
  );
}
