"use client";

import { useCallback, useEffect, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";

export function RunMonitorRefresh({ poll }: { readonly poll: boolean }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const refresh = useCallback(() => startTransition(() => router.refresh()), [router]);

  useEffect(() => {
    if (!poll) return undefined;
    const timer = window.setInterval(refresh, 1_500);
    return () => window.clearInterval(timer);
  }, [poll, refresh]);

  return <Button type="button" variant="outline" onClick={refresh} disabled={pending}>{pending ? "Refreshing" : "Refresh durable status"}</Button>;
}
