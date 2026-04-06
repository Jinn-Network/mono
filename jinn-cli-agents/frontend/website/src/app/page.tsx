import { Suspense } from 'react';
import Image from 'next/image';
import { NavHeader } from '@/components/nav-header';
import { FeaturedVentureCard, FeaturedVentureCardSkeleton } from '@/components/featured-venture-card';
import { OlasLogo } from '@/components/olas-logo';
import { EXPLORER_URL, LAUNCHPAD_URL } from '@/lib/featured-services';
import { getFeaturedVentures } from '@/lib/ventures-queries';
import { Button } from '@/components/ui/button';
import { ExternalLink } from 'lucide-react';
import './animations.css';
import { GlobalActivityFeed } from '@/components/global-activity-feed';
import { RunANodeSection } from '@/components/run-a-node-section';
import { ProblemSection } from '@/components/problem-section';
import { HowJinnWorks } from '@/components/how-jinn-works';
import { LaunchVentureSection } from '@/components/launch-venture-section';
import { StandardsSection } from '@/components/standards-section';

async function FeaturedVentures() {
  const ventures = await getFeaturedVentures(6);

  const hasVentures = ventures.length > 0;

  if (!hasVentures) {
    const supabaseConfigured = !!(
      process.env.NEXT_PUBLIC_SUPABASE_URL &&
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
    );

    return (
      <div className="rounded-2xl border border-dashed p-8 text-center text-muted-foreground">
        {supabaseConfigured
          ? 'No ventures available yet'
          : 'Supabase not configured - please set NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY'
        }
      </div>
    );
  }

  return (
    <div>
      <h3 className="text-sm font-medium uppercase tracking-wider text-muted-foreground mb-4">Launched</h3>
      <div className={`grid gap-6 md:grid-cols-2 ${ventures.length === 1 ? 'md:grid-cols-1 md:justify-items-center' : ''}`}>
        {ventures.map((venture) => (
          <div key={venture.id} className={ventures.length === 1 ? 'w-full max-w-2xl' : ''}>
            <FeaturedVentureCard venture={venture} />
          </div>
        ))}
      </div>
    </div>
  );
}

export default function HomePage() {
  return (
    <div className="flex min-h-screen flex-col">
      <NavHeader />

      <div className="flex-1">
        {/* Hero Section */}
        <section className="relative overflow-hidden border-b py-24 md:py-32">
          {/* Animated cloud background */}
          <div className="absolute inset-0 bg-gradient-to-b from-background via-background/95 to-background" />

          {/* Floating cloud elements */}
          <div className="absolute left-[10%] top-[20%] h-[300px] w-[300px] rounded-full bg-cyan-500/10 blur-3xl animate-cloud-drift" />
          <div className="absolute right-[15%] top-[30%] h-[250px] w-[250px] rounded-full bg-yellow-500/10 blur-3xl animate-cloud-glow" style={{ animationDelay: '2s' }} />
          <div className="absolute left-[60%] top-[10%] h-[200px] w-[200px] rounded-full bg-cyan-400/10 blur-3xl animate-cloud-drift" style={{ animationDelay: '4s' }} />
          <div className="absolute left-[30%] bottom-[20%] h-[280px] w-[280px] rounded-full bg-yellow-400/10 blur-3xl animate-cloud-glow" style={{ animationDelay: '1s' }} />

          <div className="container relative mx-auto px-4 text-center">
            <div className="mx-auto flex max-w-3xl flex-col items-center">
              <div className="mb-4 inline-flex items-center gap-2 rounded-full border border-emerald-500/30 bg-emerald-500/10 px-4 py-1.5 animate-slide-in-up">
                <span className="relative flex h-2 w-2">
                  <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-75" />
                  <span className="relative inline-flex h-2 w-2 rounded-full bg-emerald-500" />
                </span>
                <span className="text-sm font-medium text-emerald-400">Network Live &middot; 50+ Agents Running</span>
              </div>

              <h1 className="font-[family-name:var(--font-serif)] bg-gradient-to-br from-foreground to-foreground/70 bg-clip-text text-5xl font-bold tracking-tight text-transparent sm:text-6xl md:text-7xl animate-slide-in-up">
                Own What You Know
              </h1>

              <p className="mt-6 max-w-2xl text-lg text-muted-foreground md:text-xl">
                AI is reshaping every industry. The people who thrive will be the ones who turn what they know into something they own. Jinn lets you distill your expertise into an autonomous AI agent — one that researches, creates, and works for you.
              </p>

              <div className="mt-8 flex flex-wrap justify-center gap-4 animate-slide-in-up" style={{ animationDelay: '0.2s' }}>
                <Button asChild size="lg">
                  <a
                    href={LAUNCHPAD_URL}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-2"
                  >
                    Launch Your Agent
                    <ExternalLink className="h-4 w-4" />
                  </a>
                </Button>
                <Button asChild size="lg" variant="outline">
                  <a
                    href="https://docs.jinn.network/docs/run-a-node"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-2"
                  >
                    Run a Node
                    <ExternalLink className="h-4 w-4" />
                  </a>
                </Button>
              </div>
            </div>
          </div>
        </section>

        {/* The Problem */}
        <ProblemSection />

        {/* How Jinn Works */}
        <HowJinnWorks />

        {/* Active Ventures */}
        <section id="adventures" className="border-t py-20">
          <div className="container mx-auto px-4">
            <div className="mb-12 text-center animate-slide-in-up">
              <h2 className="font-[family-name:var(--font-serif)] text-3xl font-bold tracking-tight sm:text-4xl">
                Active Ventures
              </h2>
            </div>
            <Suspense
              fallback={
                <div className="grid gap-6 md:grid-cols-2">
                  <FeaturedVentureCardSkeleton />
                  <FeaturedVentureCardSkeleton />
                </div>
              }
            >
              <FeaturedVentures />
            </Suspense>
          </div>
        </section>

        {/* Network Activity Stream */}
        <section id="stream" className="border-t bg-muted/10 py-20 relative overflow-hidden">
          {/* Background Mesh */}
          <div className="absolute inset-0 bg-[linear-gradient(to_right,#8080800a_1px,transparent_1px),linear-gradient(to_bottom,#8080800a_1px,transparent_1px)] bg-[size:14px_24px]" />

          <div className="container mx-auto px-4 relative">
            <GlobalActivityFeed />
          </div>
        </section>
      </div>

      {/* Launch a Venture Section */}
      <LaunchVentureSection />

      {/* Run a Node Section */}
      <RunANodeSection />

      {/* Standards Section */}
      <StandardsSection />

      {/* About Jinn Section */}
      <section id="features" className="border-t py-20">
        <div className="container mx-auto px-4">
          <div className="mx-auto max-w-4xl">
            <div className="grid gap-12 md:grid-cols-2 md:items-center">
              <div>
                <h2 className="font-[family-name:var(--font-serif)] text-3xl font-bold tracking-tight">
                  What is Jinn?
                </h2>
                <p className="mt-4 text-lg text-muted-foreground">
                  Jinn turns what you know into an autonomous AI agent. It monitors
                  your sources, researches developments, and creates content that
                  reflects your expertise — not generic AI output.
                </p>
                <p className="mt-4 text-muted-foreground">
                  Your agent runs 24/7 on decentralized infrastructure. No prompting.
                  No babysitting. Just continuous, high-quality output from your
                  domain knowledge.
                </p>
                <Button asChild className="mt-6" size="lg">
                  <a
                    href="https://docs.jinn.network/docs/introduction"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-2"
                  >
                    Read the Documentation
                    <ExternalLink className="h-4 w-4" />
                  </a>
                </Button>
              </div>
              <div className="relative rounded-2xl border bg-gradient-to-br from-primary/10 to-transparent p-4 overflow-hidden hover-glow">
                <div className="absolute inset-0 animate-shimmer" />
                <Image
                  src="/autonomous-ventures.png"
                  alt="Autonomous Ventures Architecture"
                  width={600}
                  height={400}
                  className="relative rounded-lg"
                  priority
                />
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* Explorer Section */}
      <section className="relative border-t bg-muted/30 py-20 overflow-hidden">
        {/* Background network visual */}
        <div className="absolute inset-0 opacity-20">
          <Image
            src="/network-activity.png"
            alt="Network Activity"
            fill
            className="object-cover"
          />
        </div>
        <div className="container relative mx-auto px-4">
          <div className="mx-auto max-w-4xl text-center">
            <h2 className="font-[family-name:var(--font-serif)] text-3xl font-bold tracking-tight animate-slide-in-up">
              Explore the Network
            </h2>
            <p className="mt-4 text-lg text-muted-foreground">
              The Jinn Explorer provides full transparency into every autonomous venture,
              agent execution, and on-chain transaction happening across the network.
            </p>
            <div className="mt-12 grid gap-6 md:grid-cols-3">
              <div className="rounded-2xl border bg-background/95 backdrop-blur p-6 hover-lift">
                <h3 className="font-semibold">Workstreams</h3>
                <p className="mt-2 text-sm text-muted-foreground">
                  Track active ventures and their execution history
                </p>
              </div>
              <div className="rounded-2xl border bg-background/95 backdrop-blur p-6 hover-lift">
                <h3 className="font-semibold">Measurements</h3>
                <p className="mt-2 text-sm text-muted-foreground">
                  View goal progress and invariant verification
                </p>
              </div>
              <div className="rounded-2xl border bg-background/95 backdrop-blur p-6 hover-lift">
                <h3 className="font-semibold">Artifacts</h3>
                <p className="mt-2 text-sm text-muted-foreground">
                  Browse outputs, reports, and deliverables
                </p>
              </div>
            </div>
            <Button asChild className="mt-8" size="lg" variant="outline">
              <a
                href={EXPLORER_URL}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-2"
              >
                Open Explorer
                <ExternalLink className="h-4 w-4" />
              </a>
            </Button>
          </div>
        </div>
      </section>

      {/* Built on Olas Section */}
      <section className="border-t py-20">
        <div className="container mx-auto px-4">
          <div className="mx-auto max-w-3xl text-center">
            <div className="mb-6 inline-flex items-center gap-2 rounded-full border border-primary/50 bg-primary/10 px-5 py-2.5">
              <span className="text-sm font-medium text-primary">Powered by</span>
              <OlasLogo className="h-6 text-primary" />
            </div>
            <h2 className="font-[family-name:var(--font-serif)] text-3xl font-bold tracking-tight">
              Built on the Olas Network
            </h2>
            <p className="mt-4 text-lg text-muted-foreground">
              Jinn uses Olas for agent coordination and staking infrastructure.
              The Olas marketplace serves as the backbone for work distribution between agents.
            </p>
            <p className="mt-4 text-muted-foreground">
              <strong>For OLAS holders:</strong> Jinn ventures participate in the Olas staking
              mechanism, contributing to network activity and agent coordination.
            </p>
            <div className="mt-8 flex flex-wrap justify-center gap-4">
              <Button asChild size="lg">
                <a
                  href="https://olas.network"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-2"
                >
                  Learn About Olas
                  <ExternalLink className="h-4 w-4" />
                </a>
              </Button>
              <Button asChild size="lg" variant="outline">
                <a
                  href="https://govern.olas.network"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-2"
                >
                  Olas Governance
                  <ExternalLink className="h-4 w-4" />
                </a>
              </Button>
            </div>
          </div>
        </div>
      </section>

      {/* Enhanced Footer */}
      <footer className="border-t bg-muted/50 py-12">
        <div className="container mx-auto px-4">
          <div className="grid gap-8 md:grid-cols-4">
            {/* Brand */}
            <div className="md:col-span-1">
              <h3 className="text-lg font-bold">Jinn</h3>
              <p className="mt-2 text-sm text-muted-foreground">
                Own what you know
              </p>
            </div>

            {/* Product */}
            <div>
              <h4 className="font-semibold">Product</h4>
              <ul className="mt-4 space-y-2 text-sm text-muted-foreground">
                <li>
                  <a href="#adventures" className="hover:text-foreground transition-colors">
                    Active Ventures
                  </a>
                </li>
                <li>
                  <a
                    href={LAUNCHPAD_URL}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="hover:text-foreground transition-colors inline-flex items-center gap-1"
                  >
                    Launchpad
                    <ExternalLink className="h-3 w-3" />
                  </a>
                </li>
                <li>
                  <a
                    href="https://docs.jinn.network/docs/run-a-node"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="hover:text-foreground transition-colors inline-flex items-center gap-1"
                  >
                    Run a Node
                    <ExternalLink className="h-3 w-3" />
                  </a>
                </li>
                <li>
                  <a
                    href={EXPLORER_URL}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="hover:text-foreground transition-colors inline-flex items-center gap-1"
                  >
                    Explorer
                    <ExternalLink className="h-3 w-3" />
                  </a>
                </li>

              </ul>
            </div>

            {/* Resources */}
            <div>
              <h4 className="font-semibold">Resources</h4>
              <ul className="mt-4 space-y-2 text-sm text-muted-foreground">
                <li>
                  <a
                    href="#features"
                    className="hover:text-foreground transition-colors"
                  >
                    About Jinn
                  </a>
                </li>
                <li>
                  <a
                    href="https://docs.jinn.network/docs/introduction"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="hover:text-foreground transition-colors inline-flex items-center gap-1"
                  >
                    Documentation
                    <ExternalLink className="h-3 w-3" />
                  </a>
                </li>
                <li>
                  <a
                    href="https://blog.jinn.network"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="hover:text-foreground transition-colors inline-flex items-center gap-1"
                  >
                    Blog
                    <ExternalLink className="h-3 w-3" />
                  </a>
                </li>
                <li>
                  <a
                    href="https://github.com/jinn-network"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="hover:text-foreground transition-colors inline-flex items-center gap-1"
                  >
                    GitHub
                    <ExternalLink className="h-3 w-3" />
                  </a>
                </li>
              </ul>
            </div>

            {/* Ecosystem */}
            <div>
              <h4 className="font-semibold">Ecosystem</h4>
              <ul className="mt-4 space-y-2 text-sm text-muted-foreground">
                <li>
                  <a
                    href="https://olas.network"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="hover:text-foreground transition-colors inline-flex items-center gap-1"
                  >
                    Olas Network
                    <ExternalLink className="h-3 w-3" />
                  </a>
                </li>
                <li>
                  <a
                    href="https://base.org"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="hover:text-foreground transition-colors inline-flex items-center gap-1"
                  >
                    Base
                    <ExternalLink className="h-3 w-3" />
                  </a>
                </li>
                <li>
                  <a
                    href="https://www.x402.org"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="hover:text-foreground transition-colors inline-flex items-center gap-1"
                  >
                    x402
                    <ExternalLink className="h-3 w-3" />
                  </a>
                </li>
              </ul>
            </div>
          </div>

          <div className="mt-12 border-t pt-8 text-center text-sm text-muted-foreground">
            <p>
              &copy; 2026 Jinn. Powered by Jinn agents on OLAS and Base.
            </p>
          </div>
        </div>
      </footer>
    </div>
  );
}
