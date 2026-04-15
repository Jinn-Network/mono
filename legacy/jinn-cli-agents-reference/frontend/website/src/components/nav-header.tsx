"use client";

import Link from 'next/link';
import { MessageCircle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { EXPLORER_URL, LAUNCHPAD_URL } from '@/lib/featured-services';

export function NavHeader() {
  const scrollToSection = (e: React.MouseEvent<HTMLAnchorElement>, sectionId: string) => {
    e.preventDefault();
    const element = document.getElementById(sectionId);
    if (element) {
      element.scrollIntoView({ behavior: 'smooth' });
    }
  };

  return (
    <header className="sticky top-0 z-50 border-b bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60">
      <div className="container mx-auto flex h-16 items-center justify-between px-4">
        {/* Left side: Logo + All nav items */}
        <div className="flex items-center gap-8">
          <Link href="/" className="flex items-center gap-2">
            <span className="text-xl font-bold">Jinn</span>
          </Link>

          <nav className="hidden md:flex items-center gap-2">
            <Button asChild variant="ghost">
              <a href="#adventures" onClick={(e) => scrollToSection(e, 'adventures')}>
                Agents
              </a>
            </Button>
            <Button asChild variant="ghost">
              <a href={LAUNCHPAD_URL} target="_blank" rel="noopener noreferrer">
                Launch
              </a>
            </Button>
            <Button asChild variant="ghost">
              <a href="#problem" onClick={(e) => scrollToSection(e, 'problem')}>
                How It Works
              </a>
            </Button>
            <Button asChild variant="ghost">
              <a href="https://docs.jinn.network/docs/introduction" target="_blank" rel="noopener noreferrer">
                Docs
              </a>
            </Button>
            <Button asChild variant="ghost">
              <a href={EXPLORER_URL} target="_blank" rel="noopener noreferrer">
                Explorer
              </a>
            </Button>
            <Button asChild variant="ghost">
              <a href="https://docs.jinn.network/docs/run-a-node" target="_blank" rel="noopener noreferrer">
                Run a Node
              </a>
            </Button>
          </nav>
        </div>

        {/* Right side: Telegram CTA */}
        <Button asChild>
          <a
            href="https://t.me/+ZgkG_MbbhrJkMjhk"
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-2"
          >
            <MessageCircle className="h-4 w-4" />
            <span className="hidden sm:inline">Join Telegram</span>
          </a>
        </Button>
      </div>
    </header>
  );
}
