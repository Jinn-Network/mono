'use client';

import { Wallet } from 'lucide-react';
import { usePrivy } from '@privy-io/react-auth';
import { Button } from '@/components/ui/button';

export function ConnectPrompt({ message }: { message?: string }) {
  const { login } = usePrivy();

  return (
    <div className="flex flex-col items-center justify-center gap-4 py-20 text-center">
      <div className="rounded-full bg-muted p-4">
        <Wallet className="h-8 w-8 text-muted-foreground" />
      </div>
      <div className="space-y-2">
        <h2 className="text-lg font-semibold">Sign in to continue</h2>
        <p className="text-sm text-muted-foreground max-w-sm">
          {message || 'Sign in with email or wallet to get started.'}
        </p>
      </div>
      <Button onClick={login}>Sign In</Button>
    </div>
  );
}
