'use client';

import { useState } from 'react';

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { daemonJson } from '@/lib/daemon';
import { classifySurface, SurfaceStatus, useDaemonJson } from '@/lib/use-daemon';

type ClaimPolicy = {
  mode?: string;
  spendCapWei?: string;
  aiUnitCap?: number;
};

type WiringEntry = {
  workKind: string;
  harness: string;
  model?: string;
  plugins: string[];
  isolationPolicy?: string;
  legacyManifestDigest?: string;
};

type ClaimPolicyResponse = {
  claimPolicy?: ClaimPolicy;
  executionWiring?: WiringEntry[];
  restartRequired?: boolean;
};

export default function ClaimPolicyPage() {
  const { data, loading, error, reload } = useDaemonJson<ClaimPolicyResponse>(
    '/v1/operator/claim-policy',
  );
  const state = classifySurface({
    loading: loading || !data,
    error,
    empty: false,
  });

  if (state !== 'ready' || !data) {
    return (
      <div data-testid="claim-policy-tab-loading">
        <SurfaceStatus name="claimPolicy" state={state === 'ready' ? 'loading' : state} />
      </div>
    );
  }

  return (
    <ClaimPolicyEditor
      key={`${data.claimPolicy?.mode}:${data.claimPolicy?.spendCapWei ?? ''}:${data.claimPolicy?.aiUnitCap ?? ''}`}
      initial={data}
      onSaved={() => {
        void reload();
      }}
    />
  );
}

function ClaimPolicyEditor({
  initial,
  onSaved,
}: {
  initial: ClaimPolicyResponse;
  onSaved: () => void;
}) {
  const mode = initial.claimPolicy?.mode ?? 'claim-nothing';
  const [spendCapWei, setSpendCapWei] = useState(initial.claimPolicy?.spendCapWei ?? '');
  const [aiUnitCap, setAiUnitCap] = useState(String(initial.claimPolicy?.aiUnitCap ?? 0));
  const [saving, setSaving] = useState(false);
  const [restartRequired, setRestartRequired] = useState(initial.restartRequired === true);
  const entries = initial.executionWiring ?? [];
  const capsAtZero =
    initial.claimPolicy !== undefined && (spendCapWei === '0' || aiUnitCap === '0');

  async function save(): Promise<void> {
    setSaving(true);
    try {
      const result = await daemonJson<{ restartRequired?: boolean }>(
        '/v1/operator/claim-policy',
        {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            claimPolicy: { mode, spendCapWei, aiUnitCap: Number(aiUnitCap) },
          }),
        },
      );
      if (result.restartRequired) setRestartRequired(true);
      onSaved();
    } finally {
      setSaving(false);
    }
  }

  return (
    <div data-testid="claim-policy-tab" className="flex flex-col gap-4">
      <Card>
        <CardHeader>
          <CardTitle>Claim policy</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <div className="flex flex-col gap-2">
            <Label>Predicate mode</Label>
            <Badge data-testid="claim-policy-mode" variant="outline">
              {initial.claimPolicy ? mode : 'not set'}
            </Badge>
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="claim-policy-spend-cap">Spend cap (wei)</Label>
            <Input
              id="claim-policy-spend-cap"
              data-testid="claim-policy-spend-cap"
              type="text"
              inputMode="numeric"
              value={spendCapWei}
              onChange={(event) => setSpendCapWei(event.target.value)}
            />
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="claim-policy-ai-unit-cap">AI-unit cap</Label>
            <Input
              id="claim-policy-ai-unit-cap"
              data-testid="claim-policy-ai-unit-cap"
              type="text"
              inputMode="numeric"
              value={aiUnitCap}
              onChange={(event) => setAiUnitCap(event.target.value)}
            />
          </div>
          {capsAtZero ? (
            <Alert variant="warning" data-testid="claim-policy-caps-unset">
              <AlertTitle>Caps at zero</AlertTitle>
              <AlertDescription>
                No tasks will be claimed until both caps are above zero.
              </AlertDescription>
            </Alert>
          ) : null}
          <div className="flex items-center gap-2">
            <Button
              data-testid="claim-policy-save"
              type="button"
              disabled={saving}
              onClick={() => {
                void save();
              }}
            >
              {saving ? 'Saving…' : 'Save'}
            </Button>
            {restartRequired ? (
              <Badge data-testid="claim-policy-restart-required" variant="warning">
                Restart pending
              </Badge>
            ) : null}
          </div>
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Execution wiring</CardTitle>
        </CardHeader>
        <CardContent>
          {entries.length === 0 ? (
            <p
              data-testid="claim-policy-empty"
              className="m-0 font-mono text-[12px] text-muted-foreground"
            >
              Join a SolverNet to create your first execution wiring entry.
            </p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Work kind</TableHead>
                  <TableHead>Harness</TableHead>
                  <TableHead>Model</TableHead>
                  <TableHead>Plugins</TableHead>
                  <TableHead>Isolation</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {entries.map((entry) => (
                  <TableRow key={entry.workKind} data-testid="execution-wiring-row">
                    <TableCell>{entry.workKind}</TableCell>
                    <TableCell>{entry.harness}</TableCell>
                    <TableCell>{entry.model}</TableCell>
                    <TableCell>{entry.plugins.join(', ')}</TableCell>
                    <TableCell>{entry.isolationPolicy}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
