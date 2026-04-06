'use client';

import { HeartPulse, Activity, ArrowRight, Bot, GitBranch, FileText, ExternalLink } from 'lucide-react';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { LiveOutputView } from './live-output-view';
import { ArtifactsGallery } from './artifacts-gallery';
import { ActivityFeed } from './activity-feed';
import { HealthSummary } from './health-summary';
import { InvariantList, type InvariantWithMeasurement } from './invariant-list';
import { ServiceOutputCard } from './service-output-card';
import { transformToActivityItems } from '@/lib/ventures/activity-utils';
import type { ServiceOutput } from '@/lib/ventures/service-types';
import type { JobDefinition } from '@/lib/subgraph';
import type { ArtifactWithJobName } from '@/app/actions';
import { type HealthStatus } from '@jinn/shared-ui';
import { useEffect, useState } from 'react';

// Format timestamp in social media style
function formatTimeAgo(timestamp: number): string {
    const now = Date.now();
    const diff = now - timestamp;
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

interface VentureDashboardProps {
    liveOutputUrl: string | null;
    telegramUrl: string | null;
    activityData: { jobDefinitions: JobDefinition[] };
    workstreamId: string;
    invariants: InvariantWithMeasurement[];
    statusCounts: Record<HealthStatus, number>;
    primaryOutput: ServiceOutput | null;
    fetchActivity: (workstreamId: string) => Promise<{ jobDefinitions: JobDefinition[] }>;
    fetchArtifacts: (workstreamId: string) => Promise<ArtifactWithJobName[]>;
    initialTab?: 'dashboard' | 'health' | 'activity' | 'work-tree' | 'artifacts';
    initialSelectedJobId?: string | null;
}


export function VentureDashboard({
    liveOutputUrl,
    telegramUrl,
    activityData,
    workstreamId,
    invariants,
    statusCounts,
    primaryOutput,
    fetchActivity,
    fetchArtifacts,
    initialTab,
    initialSelectedJobId,
}: VentureDashboardProps) {
    const showArtifactsGallery = !liveOutputUrl && !telegramUrl;
    const defaultTab = initialTab ?? 'dashboard';
    const [activeTab, setActiveTab] = useState(defaultTab);

    useEffect(() => {
        setActiveTab(defaultTab);
    }, [defaultTab]);

    const [activityPreviewData, setActivityPreviewData] = useState(activityData);

    useEffect(() => {
        setActivityPreviewData(activityData);
    }, [activityData]);

    useEffect(() => {
        if (!workstreamId) return;

        const interval = setInterval(async () => {
            try {
                const newData = await fetchActivity(workstreamId);
                if (newData.jobDefinitions.length > 0) {
                    setActivityPreviewData(prev => {
                        const prevCount = prev.jobDefinitions.length;
                        const newCount = newData.jobDefinitions.length;
                        if (prevCount !== newCount) return newData;

                        const prevLatest = prev.jobDefinitions[0]?.lastInteraction;
                        const newLatest = newData.jobDefinitions[0]?.lastInteraction;
                        if (prevLatest !== newLatest) return newData;

                        return prev;
                    });
                }
            } catch (e) {
                console.error("Polling failed", e);
            }
        }, 5000);

        return () => clearInterval(interval);
    }, [workstreamId, fetchActivity]);

    const activityItems = transformToActivityItems(activityPreviewData.jobDefinitions).slice(0, 10);

    const total = statusCounts.healthy + statusCounts.warning + statusCounts.critical + statusCounts.unknown;
    const measured = total - statusCounts.unknown;
    const passing = statusCounts.healthy;

    return (
        <Tabs
            value={activeTab}
            onValueChange={(value) => setActiveTab(value as typeof activeTab)}
            className="flex-1 flex flex-col min-h-0"
        >
            <TabsList className="w-full md:w-fit">
                <TabsTrigger value="dashboard" className="gap-1 md:gap-2">
                    <span className="hidden sm:inline">Dashboard</span>
                    <span className="sm:hidden">Home</span>
                </TabsTrigger>
                <TabsTrigger value="health" className="gap-1 md:gap-2">
                    <HeartPulse className="h-4 w-4" />
                    <span className="hidden sm:inline">Health ({invariants.length})</span>
                    <span className="sm:hidden">{invariants.length}</span>
                </TabsTrigger>
                <TabsTrigger value="activity" className="gap-1 md:gap-2">
                    <Activity className="h-4 w-4" />
                    <span className="hidden sm:inline">Activity</span>
                </TabsTrigger>
                <TabsTrigger value="work-tree" className="gap-1 md:gap-2">
                    <GitBranch className="h-4 w-4" />
                    <span className="hidden sm:inline">Work Tree</span>
                    <span className="sm:hidden">Tree</span>
                </TabsTrigger>
                <TabsTrigger value="artifacts" className="gap-1 md:gap-2">
                    <FileText className="h-4 w-4" />
                    <span className="hidden sm:inline">Artifacts</span>
                    <span className="sm:hidden">Files</span>
                </TabsTrigger>
            </TabsList>

            {/* Dashboard Tab */}
            <TabsContent value="dashboard" className="flex-1 min-h-0 mt-4">
                <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 h-full">
                    {/* Left Column: Live Output or Artifacts Gallery (2/3) */}
                    <div className="lg:col-span-2 flex flex-col min-h-[500px]">
                        {showArtifactsGallery ? (
                            <ArtifactsGallery
                                workstreamId={workstreamId}
                                fetchArtifacts={fetchArtifacts}
                            />
                        ) : (
                            <LiveOutputView url={liveOutputUrl!} telegramUrl={telegramUrl || undefined} />
                        )}
                    </div>

                    {/* Right Column: Health + Activity (1/3) */}
                    <div className="lg:col-span-1 flex flex-col gap-4">
                        {/* Health Summary Card */}
                        <Card>
                            <CardHeader className="pb-2">
                                <div className="flex items-center justify-between">
                                    <CardTitle className="text-base flex items-center gap-2">
                                        <HeartPulse className="h-4 w-4" />
                                        Health
                                    </CardTitle>
                                    <TabsList className="h-auto p-0 bg-transparent">
                                        <TabsTrigger
                                            value="health"
                                            className="text-xs text-primary hover:underline px-0 py-0 h-auto data-[state=active]:bg-transparent data-[state=active]:shadow-none"
                                        >
                                            View all <ArrowRight className="h-3 w-3 ml-1" />
                                        </TabsTrigger>
                                    </TabsList>
                                </div>
                            </CardHeader>
                            <CardContent>
                                <div className="flex gap-4 text-center">
                                    <div className="flex-1">
                                        <div className="text-2xl font-bold text-green-500">{statusCounts.healthy}</div>
                                        <div className="text-xs text-muted-foreground">Healthy</div>
                                    </div>
                                    <div className="flex-1">
                                        <div className="text-2xl font-bold text-yellow-500">{statusCounts.warning}</div>
                                        <div className="text-xs text-muted-foreground">Warning</div>
                                    </div>
                                    <div className="flex-1">
                                        <div className="text-2xl font-bold text-red-500">{statusCounts.critical}</div>
                                        <div className="text-xs text-muted-foreground">Critical</div>
                                    </div>
                                    <div className="flex-1">
                                        <div className="text-2xl font-bold text-muted-foreground">{statusCounts.unknown}</div>
                                        <div className="text-xs text-muted-foreground">Unknown</div>
                                    </div>
                                </div>
                                {measured > 0 && (
                                    <p className="text-sm text-muted-foreground mt-3 text-center">
                                        {passing}/{measured} invariants passing
                                    </p>
                                )}
                            </CardContent>
                        </Card>

                        {/* Activity Preview Card */}
                        <Card className="flex-1 flex flex-col min-h-0">
                            <CardHeader className="pb-2">
                                <div className="flex items-center justify-between">
                                    <CardTitle className="text-base flex items-center gap-2">
                                        <Activity className="h-4 w-4" />
                                        Recent Activity
                                    </CardTitle>
                                    <TabsList className="h-auto p-0 bg-transparent">
                                        <TabsTrigger
                                            value="activity"
                                            className="text-xs text-primary hover:underline px-0 py-0 h-auto data-[state=active]:bg-transparent data-[state=active]:shadow-none"
                                        >
                                            View all <ArrowRight className="h-3 w-3 ml-1" />
                                        </TabsTrigger>
                                    </TabsList>
                                </div>
                            </CardHeader>
                            <CardContent className="flex-1 overflow-auto">
                                {activityItems.length === 0 ? (
                                    <p className="text-sm text-muted-foreground text-center py-4">No activity yet</p>
                                ) : (
                                    <div className="space-y-3">
                                        {activityItems.map((item) => (
                                            <div key={item.id} className="flex gap-2 rounded-md px-1.5 py-1">
                                                <div className="h-6 w-6 rounded-full bg-primary/10 flex items-center justify-center shrink-0">
                                                    <Bot className="h-3 w-3 text-primary" />
                                                </div>
                                                <div className="flex-1 min-w-0">
                                                    <div className="flex items-baseline gap-1.5 mb-0.5">
                                                        <span className="font-medium text-xs text-primary">
                                                            {item.jobName}
                                                        </span>
                                                        <span className="text-[10px] text-muted-foreground">
                                                            {formatTimeAgo(item.timestamp)}
                                                        </span>
                                                    </div>
                                                    <p className="text-xs text-muted-foreground line-clamp-2">
                                                        {item.message}
                                                    </p>
                                                </div>
                                            </div>
                                        ))}
                                    </div>
                                )}
                            </CardContent>
                        </Card>
                    </div>
                </div>
            </TabsContent>

            {/* Health Tab */}
            <TabsContent value="health" className="flex-1 min-h-0 mt-4 overflow-auto">
                <div className="space-y-6">
                    {primaryOutput && (
                        <ServiceOutputCard output={primaryOutput} />
                    )}
                    {invariants.length > 0 && (
                        <HealthSummary counts={statusCounts} />
                    )}
                    {invariants.length > 0 ? (
                        <InvariantList invariants={invariants} />
                    ) : (
                        <Card>
                            <CardContent className="py-8 text-center text-muted-foreground">
                                No blueprint invariants found for this venture
                            </CardContent>
                        </Card>
                    )}
                </div>
            </TabsContent>

            {/* Activity Tab */}
            <TabsContent value="activity" className="flex-1 min-h-0 mt-4">
                <div className="h-[600px]">
                    <ActivityFeed
                        initialData={activityData}
                        workstreamId={workstreamId}
                        fetchActivity={fetchActivity}
                    />
                </div>
            </TabsContent>

            {/* Work Tree Tab */}
            <TabsContent value="work-tree" className="flex-1 min-h-0 mt-4">
                <Card>
                    <CardContent className="py-0 px-0">
                        <iframe
                            src={`https://explorer.jinn.network/ventures/${workstreamId}/tree`}
                            className="w-full border-0 rounded-lg"
                            style={{ height: '700px' }}
                            title="Work Tree"
                        />
                    </CardContent>
                </Card>
            </TabsContent>

            {/* Artifacts Tab */}
            <TabsContent value="artifacts" className="flex-1 min-h-0 mt-4">
                <div className="min-h-[500px]">
                    <ArtifactsGallery
                        workstreamId={workstreamId}
                        fetchArtifacts={fetchArtifacts}
                    />
                </div>
            </TabsContent>
        </Tabs>
    );
}
