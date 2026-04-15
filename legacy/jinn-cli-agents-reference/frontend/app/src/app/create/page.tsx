'use client';

import { usePrivy } from '@privy-io/react-auth';
import { ConnectPrompt } from '@/components/connect-prompt';
import { CreateVentureForm } from '@/components/create-venture-form';
import { Card, CardContent, CardHeader } from '@/components/ui/card';

export default function CreatePage() {
  const { ready, authenticated } = usePrivy();

  if (!ready) {
    return (
      <div className="mx-auto max-w-5xl px-4 py-8">
        <Card className="max-w-lg mx-auto animate-pulse">
          <CardHeader>
            <div className="h-6 w-32 rounded bg-muted" />
            <div className="h-4 w-64 rounded bg-muted mt-2" />
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="h-9 rounded bg-muted" />
            <div className="h-9 rounded bg-muted" />
            <div className="h-16 rounded bg-muted" />
            <div className="h-24 rounded bg-muted" />
            <div className="h-10 rounded bg-muted" />
          </CardContent>
        </Card>
      </div>
    );
  }

  if (!authenticated) {
    return (
      <div className="mx-auto max-w-5xl px-4 py-8">
        <ConnectPrompt message="Sign in to create a content agent." />
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-5xl px-4 py-8">
      <CreateVentureForm />
    </div>
  );
}
