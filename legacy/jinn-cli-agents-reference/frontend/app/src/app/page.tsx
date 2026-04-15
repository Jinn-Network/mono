import Link from 'next/link';
import { Brain, Search, Sparkles, ArrowRight, TrendingUp } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { VentureFeedCard } from '@/components/venture-feed-card';
import { getVentures } from '@/lib/ventures';

export const revalidate = 30;

const VALUE_PROPS = [
  {
    icon: Brain,
    title: 'Define your expertise',
    description: 'Tell the agent what topics you know best, what sources to monitor, and what angle to take.',
    color: 'text-blue-400',
  },
  {
    icon: Search,
    title: 'Configure your sources',
    description: 'Point it at URLs, communities, research papers — anything it should watch for new developments.',
    color: 'text-purple-400',
  },
  {
    icon: Sparkles,
    title: 'AI produces content',
    description: 'Your agent researches, synthesizes, and creates original content on autopilot.',
    color: 'text-emerald-400',
  },
];

const CONTENT_VENTURE_TEMPLATE_ID = '2942d6f6-2d03-4ae1-8189-5f78fd60cee3';

export default async function HomePage() {
  const ventures = await getVentures();
  const contentVentures = ventures.filter((v) => v.venture_template_id === CONTENT_VENTURE_TEMPLATE_ID);

  return (
    <div className="mx-auto max-w-6xl px-4 py-8 space-y-16">
      {/* Hero */}
      <section className="flex flex-col items-center text-center space-y-6 py-12 md:py-20">
        <h1 className="text-3xl md:text-5xl font-bold tracking-tight max-w-3xl leading-tight">
          <span className="bg-gradient-to-r from-blue-400 to-emerald-400 bg-clip-text text-transparent">
            Own what you know
          </span>
        </h1>
        <p className="text-lg text-muted-foreground max-w-2xl">
          Turn your knowledge, skills, and interests into an AI agent that
          researches and creates content on your behalf — autonomously.
        </p>
        <Button asChild size="lg" className="rounded-full px-8 h-12 text-base">
          <Link href="/create">
            Launch Your Content Agent
            <ArrowRight className="h-4 w-4 ml-2" />
          </Link>
        </Button>
      </section>

      {/* How It Works */}
      <section className="space-y-8">
        <h2 className="text-xl font-semibold text-center">How it works</h2>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
          {VALUE_PROPS.map((prop) => (
            <Card key={prop.title} className="bg-secondary/20 border-border/50">
              <CardContent className="pt-6 space-y-3">
                <prop.icon className={`h-8 w-8 ${prop.color}`} />
                <h3 className="font-semibold">{prop.title}</h3>
                <p className="text-sm text-muted-foreground">{prop.description}</p>
              </CardContent>
            </Card>
          ))}
        </div>
      </section>

      {/* Monetization hint */}
      <section className="text-center py-6 rounded-xl border border-border/50 bg-secondary/10">
        <div className="flex items-center justify-center gap-2 text-muted-foreground">
          <TrendingUp className="h-4 w-4" />
          <span className="text-sm">Coming soon: monetize your content agent</span>
        </div>
      </section>

      {/* Content Ventures */}
      {contentVentures.length > 0 && (
        <section className="space-y-6">
          <h2 className="text-xl font-semibold">Content agents</h2>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {contentVentures.map((venture) => (
              <VentureFeedCard key={venture.id} venture={venture} />
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
