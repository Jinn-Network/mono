'use client';

import { useEffect, useState, useCallback, useRef } from 'react';
import { FileText, Loader2, ExternalLink } from 'lucide-react';
import { cn } from '@/lib/utils';
import { queryArtifacts, queryRequests, fetchIpfsContent, getJobName, type Artifact } from '@/lib/subgraph';
import { MarkdownField } from '@/components/markdown-field';
import { Badge } from '@/components/ui/badge';
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { useIsMobile } from '@/hooks/use-mobile';
// Format timestamp in social media style (e.g., "2 mins ago", "3 hours ago")
function formatTimeAgo(timestamp: string | number): string {
    const ts = typeof timestamp === 'string' ? Number(timestamp) * 1000 : Number(timestamp) * 1000;
    const now = Date.now();
    const diff = now - ts;
    const seconds = Math.floor(diff / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);
    const days = Math.floor(hours / 24);
    const months = Math.floor(days / 30);
    const years = Math.floor(days / 365);

    if (seconds < 60) return 'just now';
    if (minutes < 60) return `${minutes} min${minutes !== 1 ? 's' : ''} ago`;
    if (hours < 24) return `${hours} hour${hours !== 1 ? 's' : ''} ago`;
    if (days < 30) return `${days} day${days !== 1 ? 's' : ''} ago`;
    if (months < 12) return `${months} month${months !== 1 ? 's' : ''} ago`;
    return `${years} year${years !== 1 ? 's' : ''} ago`;
}

interface ArtifactsGalleryProps {
  workstreamId?: string;
  ventureId?: string;
  onNavigateToJob?: (jobDefinitionId: string) => void;
}

// Operational topics to exclude - these are internal system artifacts (case-insensitive)
const OPERATIONAL_TOPICS = [
  'situation',
  'measurement',
  'git_branch',
  'git/branch',
  'service_output',
];

interface ArtifactWithJobName extends Artifact {
  jobName?: string;
}

export function ArtifactsGallery({ workstreamId, ventureId, onNavigateToJob }: ArtifactsGalleryProps) {
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

  const fetchArtifacts = useCallback(async () => {
    try {
      const allArtifacts: Artifact[] = [];

      if (ventureId) {
        // Query artifacts directly by ventureId (uses indexed field)
        const response = await queryArtifacts({
          where: { ventureId },
          orderBy: 'blockTimestamp',
          orderDirection: 'desc',
          limit: 200,
        });
        allArtifacts.push(...response.items);
      } else if (workstreamId) {
        // Query artifacts by workstreamId field directly if available
        const response = await queryArtifacts({
          where: { workstreamId },
          orderBy: 'blockTimestamp',
          orderDirection: 'desc',
          limit: 200,
        });

        if (response.items.length > 0) {
          allArtifacts.push(...response.items);
        } else {
          // Fallback: iterate over requests (for Ponder versions without workstreamId on artifacts)
          const requestsResponse = await queryRequests({
            where: { workstreamId },
            limit: 200,
          });
          const requestIds = [workstreamId, ...requestsResponse.items.map(r => r.id)];
          for (const requestId of requestIds) {
            const resp = await queryArtifacts({
              where: { requestId },
              orderBy: 'blockTimestamp',
              orderDirection: 'desc',
              limit: 50,
            });
            allArtifacts.push(...resp.items);
          }
        }
      }

      // Sort by blockTimestamp descending (newest first at top)
      allArtifacts.sort((a, b) => {
        const tsA = Number(a.blockTimestamp || 0);
        const tsB = Number(b.blockTimestamp || 0);
        return tsB - tsA;
      });

      // Filter out operational topics (case-insensitive)
      const contentArtifacts = allArtifacts.filter(
        (a) => !OPERATIONAL_TOPICS.includes(a.topic.toLowerCase())
      );

      // Fetch job names for artifacts that have sourceJobDefinitionId
      const artifactsWithJobNames = await Promise.all(
        contentArtifacts.map(async (artifact) => {
          if (artifact.sourceJobDefinitionId) {
            const jobName = await getJobName(artifact.sourceJobDefinitionId);
            return { ...artifact, jobName: jobName || undefined };
          }
          return artifact;
        })
      );

      // Only update state if artifacts have actually changed
      setArtifacts(prev => {
        // If lengths differ, update
        if (prev.length !== artifactsWithJobNames.length) {
          return artifactsWithJobNames;
        }
        
        // Check if any artifact IDs or timestamps have changed
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
  }, [workstreamId, ventureId]);

  // Initial fetch and polling
  useEffect(() => {
    fetchArtifacts();

    const interval = setInterval(() => {
      fetchArtifacts();
    }, 10000); // Poll every 10 seconds

    return () => clearInterval(interval);
  }, [fetchArtifacts]);

  // Fetch content when selected artifact changes
  useEffect(() => {
    if (!selectedArtifact?.cid) {
      setArtifactContent(null);
      return;
    }

    setContentLoading(true);
    fetchIpfsContent(selectedArtifact.cid).then((result) => {
      if (result) {
        try {
          const parsed = JSON.parse(result.content);
          // Extract .content field if it exists (standard artifact format)
          const content = parsed.content || result.content;
          setArtifactContent(typeof content === 'string' ? content : JSON.stringify(content, null, 2));
        } catch {
          setArtifactContent(result.content);
        }
      } else {
        setArtifactContent('[Content not available]');
      }
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
            View the <span className="font-medium">Activity</span> or <span className="font-medium">Work Tree</span> tabs to see progress.
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
