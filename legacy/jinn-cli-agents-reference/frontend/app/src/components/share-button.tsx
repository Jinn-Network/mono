'use client';

import { useState, useRef, useEffect } from 'react';
import { Share2, Link2, Check } from 'lucide-react';
import { Button } from '@/components/ui/button';

interface ShareButtonProps {
  url: string;
  title: string;
  description?: string;
  status?: string;
}

function getShareText(title: string, status?: string): string {
  if (status === 'proposed' || status === 'bonding') {
    return `Check out ${title}, a seed autonomous venture on Jinn. Show your support and help get it launched!`;
  }
  return `Check out ${title}, an autonomous venture running live on Jinn.`;
}

export function ShareButton({ url, title, description, status }: ShareButtonProps) {
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    if (open) {
      document.addEventListener('mousedown', handleClickOutside);
      return () => document.removeEventListener('mousedown', handleClickOutside);
    }
  }, [open]);

  function handleToggle(e: React.MouseEvent) {
    e.preventDefault();
    e.stopPropagation();
    setOpen((prev) => !prev);
  }

  async function handleCopy(e: React.MouseEvent) {
    e.preventDefault();
    e.stopPropagation();
    await navigator.clipboard.writeText(url);
    setCopied(true);
    setTimeout(() => {
      setCopied(false);
      setOpen(false);
    }, 2000);
  }

  function handleShareX(e: React.MouseEvent) {
    e.preventDefault();
    e.stopPropagation();
    const text = getShareText(title, status);
    window.open(
      `https://x.com/intent/tweet?text=${encodeURIComponent(text)}&url=${encodeURIComponent(url)}`,
      '_blank',
    );
    setOpen(false);
  }

  function handleShareTelegram(e: React.MouseEvent) {
    e.preventDefault();
    e.stopPropagation();
    const text = getShareText(title, status);
    window.open(
      `https://t.me/share/url?url=${encodeURIComponent(url)}&text=${encodeURIComponent(text)}`,
      '_blank',
    );
    setOpen(false);
  }

  return (
    <div className="relative" ref={ref}>
      <Button
        variant="ghost"
        size="sm"
        className="h-8 w-8 p-0"
        onClick={handleToggle}
      >
        <Share2 className="h-4 w-4" />
      </Button>

      {open && (
        <div className="absolute right-0 top-full mt-1 z-50 w-48 rounded-md border bg-popover p-1 shadow-md">
          <button
            onClick={handleCopy}
            className="flex w-full items-center gap-2 rounded-sm px-3 py-2 text-sm hover:bg-accent transition-colors"
          >
            {copied ? <Check className="h-4 w-4 text-green-500" /> : <Link2 className="h-4 w-4" />}
            {copied ? 'Copied!' : 'Copy Link'}
          </button>
          <button
            onClick={handleShareX}
            className="flex w-full items-center gap-2 rounded-sm px-3 py-2 text-sm hover:bg-accent transition-colors"
          >
            <svg className="h-4 w-4" viewBox="0 0 24 24" fill="currentColor">
              <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z" />
            </svg>
            Share on X
          </button>
          <button
            onClick={handleShareTelegram}
            className="flex w-full items-center gap-2 rounded-sm px-3 py-2 text-sm hover:bg-accent transition-colors"
          >
            <svg className="h-4 w-4" viewBox="0 0 24 24" fill="currentColor">
              <path d="M11.944 0A12 12 0 0 0 0 12a12 12 0 0 0 12 12 12 12 0 0 0 12-12A12 12 0 0 0 12 0a12 12 0 0 0-.056 0zm4.962 7.224c.1-.002.321.023.465.14a.506.506 0 0 1 .171.325c.016.093.036.306.02.472-.18 1.898-.962 6.502-1.36 8.627-.168.9-.499 1.201-.82 1.23-.696.065-1.225-.46-1.9-.902-1.056-.693-1.653-1.124-2.678-1.8-1.185-.78-.417-1.21.258-1.91.177-.184 3.247-2.977 3.307-3.23.007-.032.014-.15-.056-.212s-.174-.041-.249-.024c-.106.024-1.793 1.14-5.061 3.345-.48.33-.913.49-1.302.48-.428-.008-1.252-.241-1.865-.44-.752-.245-1.349-.374-1.297-.789.027-.216.325-.437.893-.663 3.498-1.524 5.83-2.529 6.998-3.014 3.332-1.386 4.025-1.627 4.476-1.635z" />
            </svg>
            Share on Telegram
          </button>
        </div>
      )}
    </div>
  );
}
