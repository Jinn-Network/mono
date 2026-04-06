'use client';

import { useState, useEffect, useCallback } from 'react';
import { SiteHeader } from '@/components/site-header';
import { NodeCard, NodeCardSkeleton } from '@/components/nodes/node-card';
import { WORKER_NODES, fetchNodeHealth, type NodeHealthStatus } from '@/lib/nodes/nodes-config';
import { Button } from '@/components/ui/button';

export default function NodesPage() {
  const [healthStatus, setHealthStatus] = useState<Map<string, NodeHealthStatus | null>>(new Map());
  const [isLoading, setIsLoading] = useState(true);
  const [lastRefresh, setLastRefresh] = useState<Date | null>(null);

  const refreshHealth = useCallback(async () => {
    setIsLoading(true);
    const results = new Map<string, NodeHealthStatus | null>();

    await Promise.all(
      WORKER_NODES.map(async (node) => {
        const health = await fetchNodeHealth(node);
        results.set(node.id, health);
      })
    );

    setHealthStatus(results);
    setLastRefresh(new Date());
    setIsLoading(false);
  }, []);

  useEffect(() => {
    refreshHealth();

    // Auto-refresh every 30 seconds
    const interval = setInterval(refreshHealth, 30000);
    return () => clearInterval(interval);
  }, [refreshHealth]);

  const onlineCount = Array.from(healthStatus.values()).filter((h) => h?.status === 'ok').length;
  const totalCount = WORKER_NODES.length;

  return (
    <div className="flex min-h-screen flex-col bg-background">
      <SiteHeader
        breadcrumbs={[
          { label: 'Explorer', href: '/' },
          { label: 'Nodes' },
        ]}
      />

      <main className="flex-1 py-6">
        <div className="container mx-auto px-4">
          <div className="flex items-center justify-between mb-6">
            <div>
              <h1 className="text-2xl font-bold tracking-tight">Worker Nodes</h1>
              <p className="text-muted-foreground">
                {onlineCount} of {totalCount} nodes online
                {lastRefresh && (
                  <span className="ml-2 text-xs">
                    (last checked {lastRefresh.toLocaleTimeString()})
                  </span>
                )}
              </p>
            </div>
            <Button
              variant="outline"
              size="sm"
              onClick={refreshHealth}
              disabled={isLoading}
            >
              {isLoading ? 'Refreshing...' : 'Refresh'}
            </Button>
          </div>

          {WORKER_NODES.length === 0 ? (
            <div className="text-center py-12 text-muted-foreground">
              No nodes configured
            </div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
              {WORKER_NODES.map((node) => (
                <NodeCard
                  key={node.id}
                  node={node}
                  health={healthStatus.get(node.id) ?? null}
                  isLoading={isLoading && !healthStatus.has(node.id)}
                />
              ))}
            </div>
          )}
        </div>
      </main>
    </div>
  );
}
