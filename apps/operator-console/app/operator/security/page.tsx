'use client';

import { useState } from 'react';

import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { daemonJson, readUiToken, writeUiToken } from '@/lib/daemon';
import { classifySurface, SurfaceStatus } from '@/lib/use-daemon';

type ChangePasswordResponse = {
  ok?: boolean;
  passwordFileUpdated?: boolean;
};

export default function SecurityPage() {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [token, setToken] = useState(readUiToken() ?? '');
  const [status, setStatus] = useState<'idle' | 'rotating'>('idle');
  const [error, setError] = useState<string | null>(null);
  const [passwordFileLeftAlone, setPasswordFileLeftAlone] = useState(false);

  const surface = classifySurface({
    loading: false,
    error,
    empty: token.length === 0,
  });

  async function rotatePassword(): Promise<void> {
    setStatus('rotating');
    setError(null);
    setPasswordFileLeftAlone(false);
    try {
      const result = await daemonJson<ChangePasswordResponse>('/v1/setup/change-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ current, next }),
      });
      setCurrent('');
      setNext('');
      setPasswordFileLeftAlone(result.passwordFileUpdated === false);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setStatus('idle');
    }
  }

  return (
    <div data-testid="security-tab" className="flex flex-col gap-6">
      <Card>
        <CardHeader className="flex flex-row items-start justify-between">
          <CardTitle>Security</CardTitle>
          <Badge variant="destructive">Danger zone</Badge>
        </CardHeader>
        <CardContent>
          {surface === 'error' ? <SurfaceStatus name="security" state="error" /> : null}
          <form
            className="flex flex-col gap-4"
            data-testid="security-password-form"
            onSubmit={(event) => {
              event.preventDefault();
              void rotatePassword();
            }}
          >
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="flex flex-col gap-2">
                <Label htmlFor="current-password">Current password</Label>
                <Input
                  id="current-password"
                  type="password"
                  autoComplete="current-password"
                  value={current}
                  onChange={(event) => setCurrent(event.target.value)}
                />
              </div>
              <div className="flex flex-col gap-2">
                <Label htmlFor="next-password">New password</Label>
                <Input
                  id="next-password"
                  type="password"
                  autoComplete="new-password"
                  value={next}
                  onChange={(event) => setNext(event.target.value)}
                />
              </div>
            </div>
            <Button type="submit" variant="destructive" disabled={status === 'rotating'} className="self-start">
              {status === 'rotating' ? 'Rotating…' : 'Rotate password'}
            </Button>
            {passwordFileLeftAlone ? (
              <Alert variant="warning" data-testid="security-password-file-not-updated">
                Host-wide keystore-password file was not updated: it does not belong to this
                daemon&apos;s keystore. Set JINN_PASSWORD on every daemon start.
              </Alert>
            ) : null}
          </form>
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>UI token</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          {surface === 'empty' ? <SurfaceStatus name="security" state="empty" /> : null}
          <Label htmlFor="ui-token">x-jinn-ui-token</Label>
          <Input
            id="ui-token"
            type="password"
            value={token}
            onChange={(event) => setToken(event.target.value)}
          />
          <Button
            type="button"
            className="self-start"
            onClick={() => {
              writeUiToken(token);
            }}
          >
            Store token
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}
