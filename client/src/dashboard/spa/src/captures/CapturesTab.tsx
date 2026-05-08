import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../api/client.js';
import { CapturesList } from './CapturesList.js';
import { CaptureDrillIn } from './CaptureDrillIn.js';

export function CapturesTab(): JSX.Element {
  const qc = useQueryClient();
  const [selectedSessionId, setSelectedSessionId] = useState<string | undefined>();
  const listQuery = useQuery({
    queryKey: ['captures', 'pending'],
    queryFn: () => api.captures.listPending(),
    refetchInterval: 2500,
  });
  const captures = listQuery.data?.captures ?? [];

  useEffect(() => {
    if (!selectedSessionId && captures.length > 0) {
      setSelectedSessionId(captures[0].sessionId);
    }
    if (selectedSessionId && !captures.some((c) => c.sessionId === selectedSessionId)) {
      setSelectedSessionId(captures[0]?.sessionId);
    }
  }, [captures, selectedSessionId]);

  const detailQuery = useQuery({
    queryKey: ['captures', selectedSessionId],
    queryFn: () => api.captures.get(selectedSessionId!),
    enabled: Boolean(selectedSessionId),
  });

  const approve = useMutation({
    mutationFn: (sessionId: string) => api.captures.approve(sessionId),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ['captures'] });
    },
  });
  const skip = useMutation({
    mutationFn: (sessionId: string) => api.captures.skip(sessionId),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ['captures'] });
    },
  });
  const trustRepo = useMutation({
    mutationFn: (repoRemoteUrl: string) => api.captures.trustRepo(repoRemoteUrl, true),
  });

  return (
    <div style={{ padding: 24, display: 'grid', gridTemplateColumns: '360px 1fr', gap: 24 }}>
      <aside>
        <h1 style={{ margin: '0 0 12px', fontSize: 24 }}>Captures</h1>
        <CapturesList
          captures={captures}
          selectedSessionId={selectedSessionId}
          onSelect={setSelectedSessionId}
        />
      </aside>
      <main>
        {detailQuery.data ? (
          <CaptureDrillIn
            detail={detailQuery.data}
            approving={approve.isPending}
            skipping={skip.isPending}
            onApprove={() => selectedSessionId && approve.mutate(selectedSessionId)}
            onSkip={() => selectedSessionId && skip.mutate(selectedSessionId)}
            onTrustRepo={() => {
              const repo = detailQuery.data.capture.repoRemoteUrl;
              if (repo) trustRepo.mutate(repo);
            }}
          />
        ) : (
          <div style={{ padding: 24, color: 'var(--fg-muted)' }}>
            {listQuery.isLoading ? 'Loading captures.' : 'Select a capture.'}
          </div>
        )}
      </main>
    </div>
  );
}
