import { useEffect, useState, type JSX } from 'react';
import { api } from '../../api/client.js';
import type { HarnessAuthStatusEntry } from '../../../../../api/contract/index.js';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../../components/ui/card.js';
import { Badge } from '../../components/ui/badge.js';
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '../../components/ui/table.js';

const POLL_MS = 8000;
const DOC_BASE = 'https://github.com/Jinn-Network/mono/blob/main/docs/runbooks/rotating-harness-keys.md';

function stateBadgeVariant(state: HarnessAuthStatusEntry['state']): 'default' | 'secondary' | 'destructive' {
  if (state === 'loaded') return 'default';
  if (state === 'missing') return 'destructive';
  return 'secondary'; // unknown
}

function formatMtime(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleString();
}

function sourceLabel(entry: HarnessAuthStatusEntry): string {
  if (entry.sourceKind === 'file') return entry.sourcePath ?? '—';
  if (entry.sourceKind === 'env') return `env: ${entry.envKey ?? ''}`;
  if (entry.sourceKind === 'session') return 'CLI session';
  return 'no auth required';
}

export function HarnessAuthStatusCard(): JSX.Element {
  const [harnesses, setHarnesses] = useState<HarnessAuthStatusEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const load = async (): Promise<void> => {
      try {
        const res = await api.harnessAuthStatus();
        if (!cancelled) { setHarnesses(res.harnesses); setError(null); }
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      }
    };
    void load();
    const t = setInterval(() => { void load(); }, POLL_MS);
    return () => { cancelled = true; clearInterval(t); };
  }, []);

  return (
    <Card data-testid="harness-auth-status-card">
      <CardHeader>
        <CardTitle>Harness auth status</CardTitle>
        <CardDescription>
          Where each harness reads its credential, the masked key suffix, and when it last changed.
          Read-only — rotate keys via the linked runbook. Full keys are never shown.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {error ? (
          <p className="text-sm text-[var(--break-red)]">Auth status unavailable: {error}</p>
        ) : harnesses === null ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : harnesses.length === 0 ? (
          <p className="text-sm text-muted-foreground">No harnesses registered.</p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Harness</TableHead>
                <TableHead>Auth source</TableHead>
                <TableHead>Key suffix</TableHead>
                <TableHead>Last modified</TableHead>
                <TableHead>State</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {harnesses.map((h) => (
                <TableRow key={h.harnessName}>
                  <TableCell>
                    {h.docAnchor ? (
                      <a
                        href={`${DOC_BASE}#${h.docAnchor}`}
                        target="_blank"
                        rel="noreferrer"
                        className="underline underline-offset-2"
                      >
                        {h.harnessName}
                      </a>
                    ) : (
                      <span>{h.harnessName}</span>
                    )}
                  </TableCell>
                  <TableCell className="font-mono text-xs">{sourceLabel(h)}</TableCell>
                  <TableCell className="font-mono text-xs">{h.keySuffix ? `…${h.keySuffix}` : '—'}</TableCell>
                  <TableCell className="font-mono text-xs">{formatMtime(h.lastModified)}</TableCell>
                  <TableCell>
                    <Badge variant={stateBadgeVariant(h.state)}>{h.state}</Badge>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  );
}
