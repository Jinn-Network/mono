import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Wordmark } from "@/components/wordmark";

export function SiteHeader() {
  return <header className="border-b bg-background">
    <div className="page-frame flex min-h-32 flex-wrap items-center justify-between gap-4 py-5">
      <Wordmark />
      <nav aria-label="Primary navigation" className="flex flex-wrap items-center gap-x-5 gap-y-2 text-sm">
        <Link href="/preview/reports">Reports</Link>
        <Link href="/#how-it-works">How it works</Link>
        <Link href="/#assurance">Assurance</Link>
        <Link href="/preview/pricing">Pricing</Link>
        <Button asChild size="sm"><Link href="/workspace">Open workspace</Link></Button>
      </nav>
    </div>
  </header>;
}
