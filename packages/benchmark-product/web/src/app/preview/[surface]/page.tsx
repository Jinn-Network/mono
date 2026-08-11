import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Button } from "@/components/ui/button";
import { SiteHeader } from "@/components/site-header";
import { PREVIEW_SURFACE_CATALOG, PREVIEW_SURFACES, isPreviewSurface } from "@/lib/preview-surfaces";

export const metadata: Metadata = { title: "Future hosted preview" };

export default async function PreviewPage({ params }: { readonly params: Promise<{ surface: string }> }) {
  const { surface } = await params;
  if (!isPreviewSurface(surface)) notFound();
  const preview = PREVIEW_SURFACE_CATALOG[surface];
  return <>
    <SiteHeader />
    <div className="preview-banner"><div className="page-frame flex flex-wrap items-center justify-between gap-3 py-3"><p className="font-semibold">Preview — future hosted service</p><p className="text-sm">Read-only concept. Not connected to this workspace, billing, or an account.</p></div></div>
    <main id="main-content" tabIndex={-1} className="page-frame py-16">
      <p className="colophon-eyebrow text-muted-foreground">Hosted product preview</p>
      <h1 className="mt-4 max-w-[18ch] text-6xl">{preview.title}</h1>
      <p className="colophon-body mt-6 max-w-[60ch] text-muted-foreground">{preview.description}</p>
      <nav aria-label="Preview surfaces" className="my-10 flex flex-wrap gap-2">{PREVIEW_SURFACES.map((item) => <Button asChild key={item} size="sm" variant={item === surface ? "default" : "outline"}><Link href={`/preview/${item}`}>{item.replaceAll("-", " ")}</Link></Button>)}</nav>
      <div tabIndex={0} role="region" aria-label={`${preview.title} preview table`} className="max-w-full overflow-x-auto border-y-2 border-foreground">
        <table className="w-full min-w-[42rem] table-fixed border-collapse text-left"><thead><tr>{preview.columns.map((column) => <th className="colophon-eyebrow border-b p-4" scope="col" key={column}>{column}</th>)}</tr></thead><tbody>{preview.rows.map((row) => <tr className="border-b last:border-0" key={row.join(":")}>
          {row.map((value, index) => index === 0 ? <th className="p-4 font-medium" scope="row" key={value}>{value}</th> : <td className="p-4 text-muted-foreground" key={value}>{value}</td>)}
        </tr>)}</tbody></table>
      </div>
      <aside className="mt-10 border-l-4 border-[var(--ochre)] bg-[var(--ochre-soft)] p-5"><h2 className="text-2xl">What is real today</h2><p className="mt-2 max-w-[65ch]">The local workspace, built CLI, real local venue, deterministic public bundle, and standalone six-check verifier are available. This hosted index is intentionally not connected.</p><Button asChild className="mt-5"><Link href="/workspace">Open the local workspace</Link></Button></aside>
    </main>
  </>;
}
