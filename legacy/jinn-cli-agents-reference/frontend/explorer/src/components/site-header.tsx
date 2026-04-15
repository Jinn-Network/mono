'use client'

import Link from "next/link"
import { SidebarTrigger } from "@/components/ui/sidebar"
import { Separator } from "@/components/ui/separator"
import {
  Breadcrumb,
  BreadcrumbList,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@/components/ui/breadcrumb"

interface BreadcrumbItem {
  label: string
  href?: string
}

interface SiteHeaderProps {
  title?: string
  subtitle?: string
  backLink?: {
    href: string
    label: string
  }
  breadcrumbs?: BreadcrumbItem[]
}

export function SiteHeader({ title, subtitle, backLink, breadcrumbs }: SiteHeaderProps) {
  // If breadcrumbs are provided, use them; otherwise fall back to backLink or title
  const showBreadcrumbs = breadcrumbs && breadcrumbs.length > 0
  
  return (
    <header className="flex h-16 shrink-0 items-center gap-2 border-b px-4">
      <SidebarTrigger className="-ml-1" />
      <Separator orientation="vertical" className="mr-2 h-4" />
      <div className="flex items-center gap-2 flex-1 min-w-0">
        {showBreadcrumbs ? (
          <Breadcrumb>
            <BreadcrumbList>
              {breadcrumbs.map((item, index) => (
                <div key={index} className="contents">
                  <BreadcrumbItem>
                    {index === breadcrumbs.length - 1 ? (
                      <BreadcrumbPage className="font-semibold truncate max-w-[200px] sm:max-w-none">
                        {item.label}
                      </BreadcrumbPage>
                    ) : item.href ? (
                      <BreadcrumbLink asChild>
                        <Link href={item.href} className="truncate max-w-[150px] sm:max-w-none">
                          {item.label}
                        </Link>
                      </BreadcrumbLink>
                    ) : (
                      <span className="truncate max-w-[150px] sm:max-w-none">{item.label}</span>
                    )}
                  </BreadcrumbItem>
                  {index < breadcrumbs.length - 1 && <BreadcrumbSeparator />}
                </div>
              ))}
            </BreadcrumbList>
          </Breadcrumb>
        ) : backLink ? (
          <Link 
            href={backLink.href} 
            className="text-xs text-primary hover:text-primary"
          >
            ← {backLink.label}
          </Link>
        ) : title ? (
          <h1 className="text-lg font-semibold truncate">
            {title}
          </h1>
        ) : null}
        {subtitle && (
          <>
            <Separator orientation="vertical" className="h-4" />
            <span className="text-sm text-muted-foreground truncate">
              {subtitle}
            </span>
          </>
        )}
      </div>
    </header>
  )
}

