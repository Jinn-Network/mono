'use client';

import { useEffect, useState, useCallback, useRef } from 'react';
import { FileText, Loader2, ExternalLink } from 'lucide-react';
import { cn } from '@/lib/utils';
import { formatTimeAgo, fetchIpfsContentClient } from '@/lib/artifact-utils';
import { MarkdownField } from '@/components/markdown-field';
import { Badge } from '@/components/ui/badge';
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { useIsMobile } from '@/hooks/use-mobile';
import type { ArtifactWithJobName } from '@/app/actions';

interface ArtifactsGalleryProps {
  workstreamId: string;
  onNavigateToJob?: (jobDefinitionId: string) => void;
  fetchArtifacts: (workstreamId: string) => Promise<ArtifactWithJobName[]>;
}

export function ArtifactsGallery({ workstreamId, onNavigateToJob, fetchArtifacts }: ArtifactsGalleryProps) {
  const isMobile = useIsMobile();
  const [artifacts, setArtifacts] = useState<ArtifactWithJobName[]>([]);
  const [selectedArtifactId, setSelectedArtifactId] = useState<string | null>(null);
  const [artifactContent, setArtifactContent] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [contentLoading, setContentLoading] = useState(false);
  const [mobileSheetOpen, setMobileSheetOpen] = useState(false);
  const hasAutoSelected = useRef(false);

  // Derive selected artifact from ID
  const selectedArtifact = artifacts.find(a => a.id === selectedArtifactId) || null;

  const doFetch = useCallback(async () => {
    try {
      const artifactsWithJobNames = await fetchArtifacts(workstreamId);

      // Only update state if artifacts have actually changed
      setArtifacts(prev => {
        if (prev.length !== artifactsWithJobNames.length) {
          return artifactsWithJobNames;
        }

        const hasChanges = artifactsWithJobNames.some((newArtifact, index) => {
          const oldArtifact = prev[index];
          return !oldArtifact ||
                 oldArtifact.id !== newArtifact.id ||
                 oldArtifact.blockTimestamp !== newArtifact.blockTimestamp;
        });

        return hasChanges ? artifactsWithJobNames : prev;
      });

      // Auto-select most recent artifact only on initial load
      if (!hasAutoSelected.current && artifactsWithJobNames.length > 0) {
        setSelectedArtifactId(artifactsWithJobNames[0].id);
        hasAutoSelected.current = true;
      }

      setLoading(false);
    } catch (error) {
      console.error('Error fetching artifacts:', error);
      setLoading(false);
    }
  }, [workstreamId, fetchArtifacts]);

  // Initial fetch and polling
  useEffect(() => {
    doFetch();

    const interval = setInterval(() => {
      doFetch();
    }, 10000); // Poll every 10 seconds

    return () => clearInterval(interval);
  }, [doFetch]);

  // Fetch content when selected artifact changes
  useEffect(() => {
    if (!selectedArtifact?.cid) {
      setArtifactContent(null);
      return;
    }

    setContentLoading(true);
    fetchIpfsContentClient(selectedArtifact.cid).then((content) => {
      setArtifactContent(content || '[Content not available]');
      setContentLoading(false);
    });
  }, [selectedArtifact]);

  if (loading) {
    return (
      <div className="h-full flex flex-col overflow-hidden border-2 shadow-sm rounded-xl bg-background/50 backdrop-blur-sm">
        {/* Browser Chrome Header */}
        <div className="h-10 border-b bg-muted/30 px-4 flex items-center shrink-0">
          <div className="flex gap-2">
            <div className="h-3 w-3 rounded-full bg-red-400/80" />
            <div className="h-3 w-3 rounded-full bg-yellow-400/80" />
            <div className="h-3 w-3 rounded-full bg-green-400/80" />
          </div>
          <span className="ml-4 text-sm text-muted-foreground">Artifacts Gallery</span>
        </div>
        <div className="flex-1 flex items-center justify-center">
          <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
        </div>
      </div>
    );
  }

  if (artifacts.length === 0) {
    return (
      <div className="h-full flex flex-col overflow-hidden border-2 shadow-sm rounded-xl bg-background/50 backdrop-blur-sm">
        {/* Browser Chrome Header */}
        <div className="h-10 border-b bg-muted/30 px-4 flex items-center shrink-0">
          <div className="flex gap-2">
            <div className="h-3 w-3 rounded-full bg-red-400/80" />
            <div className="h-3 w-3 rounded-full bg-yellow-400/80" />
            <div className="h-3 w-3 rounded-full bg-green-400/80" />
          </div>
          <span className="ml-4 text-sm text-muted-foreground">Artifacts Gallery</span>
        </div>
        <div className="flex-1 flex flex-col items-center justify-center p-8 text-center">
          <FileText className="h-12 w-12 text-muted-foreground/50 mb-4" />
          <h3 className="text-lg font-medium text-foreground mb-2">No Content Artifacts Yet</h3>
          <p className="text-sm text-muted-foreground max-w-md">
            This venture is actively working but hasn&apos;t published content artifacts yet.
            Some ventures commit outputs to git repositories instead.
            View the <span className="font-medium">Activity</span> tab to see progress.
          </p>
        </div>
      </div>
    );
  }

  // Handler for selecting an artifact
  const handleSelectArtifact = (artifactId: string) => {
    setSelectedArtifactId(artifactId);
    if (isMobile) {
      setMobileSheetOpen(true);
    }
  };

  // Content display component - reused for both mobile and desktop
  const ContentDisplay = () => (
    <>
      {contentLoading ? (
        <div className="h-full flex items-center justify-center py-12">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </div>
      ) : artifactContent ? (
        <div className="p-4">
          <MarkdownField content={artifactContent} showRawToggle={false} />
        </div>
      ) : (
        <div className="h-full flex items-center justify-center text-muted-foreground py-12">
          Select an artifact to view its content
        </div>
      )}
    </>
  );

  // Artifact list item component - reused for both layouts
  const ArtifactListItem = ({ artifact }: { artifact: ArtifactWithJobName }) => (
    <button
      key={artifact.id}
      onClick={() => handleSelectArtifact(artifact.id)}
      className={cn(
        "w-full text-left p-3 rounded-lg transition-colors",
        selectedArtifactId === artifact.id
          ? "bg-primary/10 border border-primary/30"
          : "hover:bg-muted/50"
      )}
    >
      <div className="flex items-start gap-2">
        <Badge variant="secondary" className="text-[10px] shrink-0 uppercase">
          {artifact.topic}
        </Badge>
      </div>
      <div className="font-medium text-sm mt-1 line-clamp-2">
        {artifact.name || 'Untitled'}
      </div>
      {artifact.jobName && artifact.sourceJobDefinitionId && onNavigateToJob && (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onNavigateToJob(artifact.sourceJobDefinitionId!);
          }}
          className="text-xs text-primary hover:underline mt-1 flex items-center gap-1"
        >
          {artifact.jobName}
          <ExternalLink className="h-3 w-3" />
        </button>
      )}
      {artifact.jobName && (!artifact.sourceJobDefinitionId || !onNavigateToJob) && (
        <div className="text-xs text-muted-foreground mt-1">
          Job: {artifact.jobName}
        </div>
      )}
      <div className="text-[10px] text-muted-foreground/70 mt-1">
        {artifact.blockTimestamp
          ? formatTimeAgo(artifact.blockTimestamp)
          : 'Unknown time'}
      </div>
    </button>
  );

  return (
    <div className="h-full flex flex-col overflow-hidden border-2 shadow-sm rounded-xl bg-background/50 backdrop-blur-sm">
      {/* Browser Chrome Header */}
      <div className="h-10 border-b bg-muted/30 px-4 flex items-center shrink-0">
        <div className="flex gap-2">
          <div className="h-3 w-3 rounded-full bg-red-400/80" />
          <div className="h-3 w-3 rounded-full bg-yellow-400/80" />
          <div className="h-3 w-3 rounded-full bg-green-400/80" />
        </div>
        <span className="ml-4 text-sm text-muted-foreground">Artifacts Gallery</span>
        <span className="ml-2 text-xs text-muted-foreground/70">({artifacts.length} artifacts)</span>
      </div>

      {/* Responsive layout */}
      <div className="flex-1 flex min-h-0">
        {/* Artifact list - full width on mobile, fixed width on desktop */}
        <div className={cn(
          "border-r bg-muted/20 overflow-y-auto",
          isMobile ? "w-full" : "w-72 shrink-0"
        )}>
          <div className="p-2 space-y-1">
            {artifacts.map((artifact) => (
              <ArtifactListItem key={artifact.id} artifact={artifact} />
            ))}
          </div>
        </div>

        {/* Desktop content pane */}
        {!isMobile && (
          <div className="flex-1 overflow-y-auto bg-background">
            <ContentDisplay />
          </div>
        )}
      </div>

      {/* Mobile Sheet for content */}
      {isMobile && (
        <Sheet open={mobileSheetOpen} onOpenChange={setMobileSheetOpen}>
          <SheetContent side="bottom" className="h-[80vh] overflow-hidden flex flex-col">
            <SheetHeader className="flex-shrink-0 pb-2 border-b">
              <SheetTitle className="text-base truncate">
                {selectedArtifact?.name || 'Artifact Content'}
              </SheetTitle>
            </SheetHeader>
            <div className="flex-1 overflow-y-auto">
              <ContentDisplay />
            </div>
          </SheetContent>
        </Sheet>
      )}
    </div>
  );
}
