'use client';

import { useState, memo, useMemo } from 'react';
import { ExternalLink, Globe, MessageCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

// Separate memoized iframe component to prevent re-renders
const StableIframe = memo(function StableIframe({ url }: { url: string }) {
    return (
        <iframe
            src={url}
            className="w-full h-full border-0"
            title="Live Service Output - Blog"
            allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
            sandbox="allow-same-origin allow-scripts allow-popups allow-forms"
        />
    );
});

interface LiveOutputViewProps {
    url: string;
    telegramUrl?: string;
}

export const LiveOutputView = memo(function LiveOutputView({ url, telegramUrl }: LiveOutputViewProps) {
    const [activeTab, setActiveTab] = useState<'blog' | 'telegram'>('blog');

    return (
        <div className="h-full flex flex-col overflow-hidden border-2 shadow-sm rounded-xl bg-background/50 backdrop-blur-sm">
            {/* Browser Chrome Header with Output Tabs */}
            <div className="h-10 border-b bg-muted/30 px-4 flex items-center justify-between shrink-0">
                <div className="flex items-center gap-4">
                    <div className="flex gap-2">
                        <div className="h-3 w-3 rounded-full bg-red-400/80" />
                        <div className="h-3 w-3 rounded-full bg-yellow-400/80" />
                        <div className="h-3 w-3 rounded-full bg-green-400/80" />
                    </div>

                    {/* Output Channel Tabs */}
                    {telegramUrl && (
                        <div className="flex gap-1 bg-muted/50 rounded-md p-0.5">
                            <button
                                onClick={() => setActiveTab('blog')}
                                className={cn(
                                    "flex items-center gap-1.5 px-2.5 py-1 rounded text-xs transition-colors",
                                    activeTab === 'blog'
                                        ? "bg-background text-foreground shadow-sm"
                                        : "text-muted-foreground hover:text-foreground"
                                )}
                            >
                                <Globe className="h-3 w-3" />
                                Blog
                            </button>
                            <button
                                onClick={() => setActiveTab('telegram')}
                                className={cn(
                                    "flex items-center gap-1.5 px-2.5 py-1 rounded text-xs transition-colors",
                                    activeTab === 'telegram'
                                        ? "bg-background text-foreground shadow-sm"
                                        : "text-muted-foreground hover:text-foreground"
                                )}
                            >
                                <MessageCircle className="h-3 w-3" />
                                Telegram
                            </button>
                        </div>
                    )}
                </div>

                <div className="flex items-center gap-2">
                    <div className="h-6 bg-background rounded-md border flex items-center justify-center px-3 text-xs text-muted-foreground truncate max-w-[200px]">
                        {activeTab === 'blog' || !telegramUrl ? url : telegramUrl}
                    </div>
                    <Button variant="ghost" size="sm" asChild className="gap-1.5 text-muted-foreground hover:text-foreground h-7 px-2">
                        <a
                            href={activeTab === 'blog' || !telegramUrl ? url : telegramUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                        >
                            <span className="text-xs">Open</span>
                            <ExternalLink className="h-3 w-3" />
                        </a>
                    </Button>
                </div>
            </div>

            {/* Content Area */}
            <div className="w-full flex-1 bg-white relative">
                {activeTab === 'blog' || !telegramUrl ? (
                    <StableIframe url={url} />
                ) : (
                    <div className="w-full h-full flex flex-col items-center justify-center bg-gradient-to-b from-[#0088cc]/5 to-[#0088cc]/10 p-8">
                        <div className="max-w-md text-center space-y-6">
                            <div className="h-20 w-20 rounded-full bg-[#0088cc] flex items-center justify-center mx-auto">
                                <MessageCircle className="h-10 w-10 text-white" />
                            </div>
                            <div>
                                <h3 className="text-xl font-semibold text-foreground mb-2">
                                    Live on Telegram
                                </h3>
                                <p className="text-muted-foreground text-sm">
                                    This venture posts updates, insights, and content directly to Telegram.
                                    Join the channel to follow along in real-time.
                                </p>
                            </div>
                            <Button asChild size="lg" className="bg-[#0088cc] hover:bg-[#0077b5]">
                                <a
                                    href={telegramUrl}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    className="gap-2"
                                >
                                    <MessageCircle className="h-5 w-5" />
                                    Open Telegram Channel
                                </a>
                            </Button>
                        </div>
                    </div>
                )}
            </div>
        </div>
    );
});
