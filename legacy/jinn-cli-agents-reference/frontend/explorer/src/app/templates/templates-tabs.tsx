'use client';

import Link from 'next/link';
import { Badge } from '@/components/ui/badge';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import type { Blueprint, VentureTemplate } from '@/lib/ventures-services';

function StatusBadge({ status }: { status: string }) {
  const colors: Record<string, string> = {
    published: 'bg-green-500/10 text-green-500 border-green-500/20',
    draft: 'bg-yellow-500/10 text-yellow-500 border-yellow-500/20',
    archived: 'bg-gray-500/10 text-gray-500 border-gray-500/20',
  };
  return (
    <Badge variant="outline" className={colors[status] || colors.archived}>
      {status}
    </Badge>
  );
}

function SafetyBadge({ tier }: { tier: string }) {
  const colors: Record<string, string> = {
    public: 'bg-blue-500/10 text-blue-500 border-blue-500/20',
    private: 'bg-orange-500/10 text-orange-500 border-orange-500/20',
    restricted: 'bg-red-500/10 text-red-500 border-red-500/20',
  };
  return (
    <Badge variant="outline" className={colors[tier] || colors.public}>
      {tier}
    </Badge>
  );
}

function formatDate(dateString: string) {
  return new Date(dateString).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

function WorkstreamTable({
  templates,
  ventureMap,
}: {
  templates: Blueprint[];
  ventureMap: Record<string, string>;
}) {
  if (templates.length === 0) {
    return (
      <div className="text-center py-12 text-muted-foreground">
        No workstream templates found
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <p className="text-muted-foreground">
        {templates.length} template{templates.length !== 1 ? 's' : ''}
      </p>
      <div className="rounded-md border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead>Description</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Version</TableHead>
              <TableHead>Price</TableHead>
              <TableHead>Tier</TableHead>
              <TableHead>Created</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {templates.map((t) => (
              <TableRow key={t.id}>
                <TableCell className="whitespace-nowrap">
                  <Link href={`/templates/workstreams/${t.id}`} className="font-medium hover:text-primary hover:underline">
                    {t.name}
                  </Link>
                </TableCell>
                <TableCell className="max-w-[300px]">
                  <p className="text-sm text-muted-foreground truncate">{t.description || '-'}</p>
                </TableCell>
                <TableCell><StatusBadge status={t.status} /></TableCell>
                <TableCell className="text-sm font-mono">{t.version}</TableCell>
                <TableCell className="text-sm whitespace-nowrap">
                  {t.price_usd ? t.price_usd : t.price_wei ? <span className="font-mono text-muted-foreground">{t.price_wei}</span> : <span className="text-muted-foreground">-</span>}
                </TableCell>
                <TableCell><SafetyBadge tier={t.safety_tier} /></TableCell>
                <TableCell className="text-sm text-muted-foreground whitespace-nowrap">{formatDate(t.created_at)}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}

function VentureTable({
  templates,
  ventureMap,
}: {
  templates: VentureTemplate[];
  ventureMap: Record<string, string>;
}) {
  if (templates.length === 0) {
    return (
      <div className="text-center py-12 text-muted-foreground">
        No venture templates found
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <p className="text-muted-foreground">
        {templates.length} template{templates.length !== 1 ? 's' : ''}
      </p>
      <div className="rounded-md border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead>Description</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Version</TableHead>
              <TableHead>Model</TableHead>
              <TableHead>Tier</TableHead>
              <TableHead>Created</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {templates.map((t) => (
              <TableRow key={t.id}>
                <TableCell className="whitespace-nowrap">
                  <Link href={`/templates/ventures/${t.id}`} className="font-medium hover:text-primary hover:underline">
                    {t.name}
                  </Link>
                </TableCell>
                <TableCell className="max-w-[300px]">
                  <p className="text-sm text-muted-foreground truncate">{t.description || '-'}</p>
                </TableCell>
                <TableCell><StatusBadge status={t.status} /></TableCell>
                <TableCell className="text-sm font-mono">{t.version}</TableCell>
                <TableCell className="text-sm whitespace-nowrap">{t.model}</TableCell>
                <TableCell><SafetyBadge tier={t.safety_tier} /></TableCell>
                <TableCell className="text-sm text-muted-foreground whitespace-nowrap">{formatDate(t.created_at)}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}

export function TemplatesTabs({
  workstreamTemplates,
  ventureTemplates,
  ventureMap,
}: {
  workstreamTemplates: Blueprint[];
  ventureTemplates: VentureTemplate[];
  ventureMap: Record<string, string>;
}) {
  return (
    <Tabs defaultValue="ventures">
      <TabsList>
        <TabsTrigger value="ventures">
          Ventures ({ventureTemplates.length})
        </TabsTrigger>
        <TabsTrigger value="workstreams">
          Workstreams ({workstreamTemplates.length})
        </TabsTrigger>
      </TabsList>
      <TabsContent value="ventures">
        <VentureTable templates={ventureTemplates} ventureMap={ventureMap} />
      </TabsContent>
      <TabsContent value="workstreams">
        <WorkstreamTable templates={workstreamTemplates} ventureMap={ventureMap} />
      </TabsContent>
    </Tabs>
  );
}
