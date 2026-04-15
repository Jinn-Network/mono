"use client";

import { Card } from "@/components/ui/card";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Bot } from "lucide-react";
import { useEffect, useState, useRef } from "react";
import { transformToActivityItems, type ActivityItem } from "@/lib/ventures/activity-utils";
import type { JobDefinition } from "@/lib/subgraph";
import { cn } from "@/lib/utils";

// Format timestamp in social media style (e.g., "2 mins ago", "3 hours ago")
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

interface ActivityFeedProps {
    initialData: { jobDefinitions: JobDefinition[] };
    workstreamId?: string;
    fetchActivity: (workstreamId: string) => Promise<{ jobDefinitions: JobDefinition[] }>;
}

/**
 * ActivityFeed - Chat-like interface showing agent status updates
 */
export function ActivityFeed({ initialData, workstreamId, fetchActivity }: ActivityFeedProps) {
    const [data, setData] = useState(initialData);
    const [newItemIds, setNewItemIds] = useState<Set<string>>(new Set());
    const seenIdsRef = useRef<Set<string>>(new Set());
    const isInitialMount = useRef(true);

    useEffect(() => {
        setData(initialData);
        // Mark all initial items as seen
        const initialMessages = transformToActivityItems(initialData.jobDefinitions);
        initialMessages.forEach(msg => seenIdsRef.current.add(msg.id));
        isInitialMount.current = false;
    }, [initialData]);

    useEffect(() => {
        if (!workstreamId) return;

        const interval = setInterval(async () => {
            try {
                const newData = await fetchActivity(workstreamId);
                if (newData.jobDefinitions.length > 0) {
                    setData(prev => {
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

    const messages = transformToActivityItems(data.jobDefinitions);

    // Detect new items and trigger animations
    useEffect(() => {
        if (isInitialMount.current) return;

        const freshIds = new Set<string>();
        for (const msg of messages) {
            if (!seenIdsRef.current.has(msg.id)) {
                freshIds.add(msg.id);
                seenIdsRef.current.add(msg.id);
            }
        }

        if (freshIds.size > 0) {
            setNewItemIds(freshIds);
            // Clear animation state after animation completes
            const timer = setTimeout(() => setNewItemIds(new Set()), 600);
            return () => clearTimeout(timer);
        }
    }, [messages]);

    if (messages.length === 0) {
        return (
            <div className="h-full flex flex-col">
                <Card className="flex-1 border-0 shadow-none bg-transparent flex items-center justify-center">
                    <p className="text-muted-foreground text-sm">No activity yet</p>
                </Card>
            </div>
        );
    }

    return (
        <div className="h-full flex flex-col">
            <ScrollArea className="flex-1 pr-4">
                <div className="space-y-4 pb-4">
                    {messages.map((msg) => (
                        <ChatMessage key={msg.id} message={msg} isNew={newItemIds.has(msg.id)} />
                    ))}
                </div>
            </ScrollArea>
        </div>
    );
}

function ChatMessage({ message, isNew }: { message: ActivityItem; isNew?: boolean }) {
    return (
        <div
            className={cn(
                "flex gap-3 transition-all duration-500 ease-out",
                isNew && "animate-in fade-in-0 slide-in-from-bottom-2"
            )}
        >
            {/* Agent Avatar */}
            <div className="shrink-0">
                <div className="h-8 w-8 rounded-full bg-primary/10 flex items-center justify-center">
                    <Bot className="h-4 w-4 text-primary" />
                </div>
            </div>

            {/* Message Content */}
            <div className="flex-1 min-w-0">
                {/* Agent Name & Time */}
                <div className="flex items-baseline gap-2 mb-1">
                    <span className="font-medium text-sm text-primary">
                        {message.jobName}
                    </span>
                    <span className="text-xs text-muted-foreground">
                        {formatTimeAgo(message.timestamp)}
                    </span>
                </div>

                {/* Chat Bubble */}
                <div className="bg-muted/50 rounded-2xl rounded-tl-sm px-4 py-2.5 inline-block max-w-full">
                    <p className="text-sm text-foreground/90 whitespace-pre-wrap break-words">
                        {message.message}
                    </p>
                </div>
            </div>
        </div>
    );
}
