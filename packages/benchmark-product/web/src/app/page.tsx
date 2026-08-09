import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { PRODUCT_BRANDING } from "@/lib/branding";
import Link from "next/link";

export default function Page() {
  return (
    <main id="main-content" tabIndex={-1} className="mx-auto flex max-w-4xl flex-col gap-10 px-6 py-16 outline-none">
      <div className="flex flex-col gap-3">
        <h1 className="text-3xl font-semibold tracking-tight">
          {PRODUCT_BRANDING.displayName}
        </h1>
        <p className="text-lg text-muted-foreground">{PRODUCT_BRANDING.tagline}</p>
      </div>

      <p className="text-base">
        It compares agent configurations on the same tasks, so a difference in
        the results reflects a difference in the configurations, not a
        difference in the tasks.
      </p>

      <div className="grid grid-cols-1 gap-6 md:grid-cols-3">
        <Card>
          <CardHeader>
            <CardTitle>You provide</CardTitle>
            <CardDescription>The three inputs a benchmark run needs.</CardDescription>
          </CardHeader>
          <CardContent>
            <dl className="flex flex-col gap-4 text-sm">
              <div>
                <dt className="font-medium">Tasks</dt>
                <dd className="text-muted-foreground">
                  The work items every configuration attempts.
                </dd>
              </div>
              <div>
                <dt className="font-medium">Configurations</dt>
                <dd className="text-muted-foreground">
                  Two or more agent setups to compare.
                </dd>
              </div>
              <div>
                <dt className="font-medium">Evaluation</dt>
                <dd className="text-muted-foreground">
                  What counts as success, and how much independent judgment
                  each result gets.
                </dd>
              </div>
            </dl>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Every run accounts for</CardTitle>
            <CardDescription>What gets measured, not just who won.</CardDescription>
          </CardHeader>
          <CardContent>
            <p className="text-sm text-muted-foreground">
              Quality, cost, runtime, failures, and evaluator disagreement.
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>You get</CardTitle>
            <CardDescription>A credible, checkable report.</CardDescription>
          </CardHeader>
          <CardContent>
            <p className="text-sm text-muted-foreground">
              Complete run and evaluation accounting, stated limitations, and
              machine-readable evidence references.
            </p>
          </CardContent>
        </Card>
      </div>

      <Button asChild className="self-start"><Link href="/workspace">Open workspace</Link></Button>
    </main>
  );
}
