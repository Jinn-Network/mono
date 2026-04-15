"use client";

import { useEffect, useState } from "react";
import { type ActivityItem, transformToActivityItems } from "@/lib/activity-utils";
import { Terminal, Brain, Rocket, CheckCircle2, AlertCircle, Sparkles } from "lucide-react";
import { motion, AnimatePresence } from "framer-motion";

export function GlobalActivityFeed() {
    const [activities, setActivities] = useState<ActivityItem[]>([]);

    useEffect(() => {
        let isMounted = true;

        async function fetchData() {
            try {
                const response = await fetch("/api/global-activity", {
                    cache: "no-store",
                });

                if (!response.ok) {
                    return;
                }

                const data = await response.json();
                const items = await transformToActivityItems(data.requests, data.deliveries);
                if (isMounted) {
                    setActivities(items);
                }
            } catch (error) {
                console.error("Failed to fetch global activity:", error);
            }
        }

        fetchData();
        const interval = setInterval(fetchData, 4000); // Poll every 4 seconds

        return () => {
            isMounted = false;
            clearInterval(interval);
        };
    }, []);

    return (
        <div className="w-full max-w-6xl mx-auto">
            <div className="mb-4 flex items-end justify-between gap-4">
                <div className="space-y-2">
                    <div className="inline-flex items-center gap-2 rounded-full border border-teal-500/25 bg-teal-500/10 px-3 py-1 text-[11px] font-medium uppercase tracking-[0.14em] text-teal-700 dark:text-teal-300">
                        <span className="relative inline-flex h-2 w-2">
                            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-teal-500 opacity-75" />
                            <span className="relative inline-flex h-2 w-2 rounded-full bg-teal-500" />
                        </span>
                        Live
                    </div>
                    <h2 className="text-2xl font-[family-name:var(--font-serif)] font-semibold tracking-tight">
                        LIVE AGENT STREAM
                    </h2>
                </div>
                <div className="text-right text-xs text-muted-foreground">
                    <div>Connected to Jinn Network</div>
                    <div className="font-mono text-[11px]">Polling every 4s</div>
                </div>
            </div>

            <div className="relative overflow-hidden rounded-2xl border border-black/10 bg-[linear-gradient(160deg,rgba(16,185,129,0.08),rgba(15,23,42,0.02)_30%,rgba(2,6,23,0.06)_100%)] shadow-[0_24px_60px_-32px_rgba(2,6,23,0.45)] dark:border-white/10 dark:bg-[linear-gradient(160deg,rgba(20,184,166,0.14),rgba(2,6,23,0.35)_30%,rgba(2,6,23,0.7)_100%)]">
                <div className="absolute inset-0 bg-[radial-gradient(circle_at_18%_0%,rgba(45,212,191,0.12),transparent_35%)]" />
                <div className="absolute inset-0 bg-[linear-gradient(to_right,rgba(148,163,184,0.07)_1px,transparent_1px),linear-gradient(to_bottom,rgba(148,163,184,0.06)_1px,transparent_1px)] bg-[size:20px_20px] opacity-30" />

                <div className="relative hidden border-b border-black/10 px-4 py-3 text-[11px] font-semibold uppercase tracking-[0.12em] text-muted-foreground md:grid md:grid-cols-12 md:gap-4 dark:border-white/10">
                    <div className="col-span-2">Timestamp</div>
                    <div className="col-span-3">Venture</div>
                    <div className="col-span-2">Job</div>
                    <div className="col-span-5">Activity</div>
                </div>

                <div className="relative min-h-[460px] space-y-2 p-3 sm:p-4">
                    <AnimatePresence initial={false} mode="popLayout">
                        {activities.map((item) => (
                            <ActivityRow key={item.id} item={item} />
                        ))}
                    </AnimatePresence>

                    {activities.length === 0 && (
                        <div className="py-24 text-center text-muted-foreground">
                            <div className="mb-2 text-sm font-medium">Waiting for new network events...</div>
                            <div className="text-xs">Stream will populate as agents dispatch and deliver jobs.</div>
                        </div>
                    )}
                </div>
            </div>
        </div>
    );
}

function ActivityRow({ item }: { item: ActivityItem }) {
    return (
        <motion.div
            layout
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.98 }}
            transition={{ duration: 0.4, ease: "easeOut" }}
            className="grid grid-cols-1 gap-3 rounded-xl border border-black/10 bg-background/75 p-3 transition-colors hover:bg-background/95 md:grid-cols-12 md:items-start md:gap-4 dark:border-white/10 dark:bg-black/30 dark:hover:bg-black/40"
        >
            <div className="col-span-2 text-[11px] font-mono text-muted-foreground">
                {new Date(item.timestamp).toLocaleTimeString([], { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' })}
            </div>

            <div className="col-span-3">
                <a
                    href={item.explorerUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex max-w-full items-center rounded-full border border-teal-500/20 bg-teal-500/10 px-2.5 py-1 text-[11px] font-medium text-teal-700 transition-colors hover:bg-teal-500/20 dark:text-teal-200"
                    onClick={(e) => e.stopPropagation()}
                >
                    <span className="truncate">
                        {item.ventureName}
                    </span>
                </a>
            </div>

            <a
                href={item.explorerUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="col-span-2 truncate text-sm font-medium text-foreground/85 transition-colors hover:text-foreground hover:underline"
                onClick={(e) => e.stopPropagation()}
            >
                {item.jobName}
            </a>

            <div className="col-span-5 flex items-start gap-3">
                <div className="mt-0.5">
                    <StatusIcon type={item.type} />
                </div>
                <span className={`text-sm leading-5 ${getStatusColor(item.type)} break-words`}>
                    {item.message.length > 220 ? `${item.message.slice(0, 220)}...` : item.message}
                </span>
            </div>
        </motion.div>
    );
}

function StatusIcon({ type }: { type: ActivityItem['type'] }) {
    switch (type) {
        case 'started': return <Rocket className="h-4 w-4 text-sky-500" />;
        case 'completed': return <CheckCircle2 className="h-4 w-4 text-emerald-500" />;
        case 'thinking': return <Brain className="h-4 w-4 text-amber-500" />;
        case 'action': return <Terminal className="h-4 w-4 text-teal-500" />;
        case 'error': return <AlertCircle className="h-4 w-4 text-rose-500" />;
        default: return <Sparkles className="h-4 w-4 text-muted-foreground" />;
    }
}

function getStatusColor(type: ActivityItem['type']) {
    switch (type) {
        case 'started': return 'text-foreground/90';
        case 'completed': return 'text-foreground/90';
        case 'thinking': return 'text-foreground/90';
        case 'action': return 'text-foreground/90';
        case 'error': return 'text-rose-600 dark:text-rose-300';
        default: return 'text-muted-foreground';
    }
}
