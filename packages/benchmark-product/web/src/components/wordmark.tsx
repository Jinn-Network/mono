import Image from "next/image";
import Link from "next/link";

export function Wordmark({ compact = false }: { readonly compact?: boolean }) {
  return <Link href="/" className="inline-flex items-center gap-3 text-foreground no-underline" aria-label="Colophon home">
    <Image className="colophon-mark size-6" src="/brand/mark.svg" width={24} height={24} alt="" priority />
    <span className={compact ? "colophon-display text-xl" : "colophon-display text-3xl"}>Colophon</span>
  </Link>;
}
