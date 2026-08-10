const LIFECYCLE = ["draft", "preview", "quoted", "locked", "running", "closed", "reported", "published-bundle"] as const;

export function LifecycleRail({ state }: { readonly state?: string }) {
  const current = state === undefined ? -1 : LIFECYCLE.indexOf(state as typeof LIFECYCLE[number]);
  return <nav aria-label="Benchmark lifecycle" className="max-w-full overflow-x-auto border-y bg-card">
    <ol className="grid min-w-[54rem] grid-cols-8">
      {LIFECYCLE.map((step, index) => <li className={`border-r px-4 py-3 last:border-r-0 ${index === current ? "border-t-2 border-t-[var(--vermilion)] bg-[var(--vermilion-soft)]" : index < current ? "border-t-2 border-t-foreground" : "border-t-2 border-t-transparent text-muted-foreground"}`} aria-current={index === current ? "step" : undefined} key={step}>
        <span className="block font-mono text-[10px] text-muted-foreground">{String(index + 1).padStart(2, "0")}</span>
        <span className="mt-1 block text-xs font-semibold">{step === "published-bundle" ? "published" : step}</span>
      </li>)}
    </ol>
  </nav>;
}
