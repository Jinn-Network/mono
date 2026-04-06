'use client'

import * as React from "react"
import Link from "next/link"
import { usePathname } from "next/navigation"
import { ChevronRight, Workflow, Briefcase, FileText, Home, Info, Rocket, BookOpen, Newspaper, Github, Server, Layers } from "lucide-react"
import { ThemeToggle } from "@/components/theme-toggle"

import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSub,
  SidebarMenuSubButton,
  SidebarMenuSubItem,
  SidebarRail,
} from "@/components/ui/sidebar"
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible"
import { navigationItems } from "@/lib/utils"
import { RealtimeStatusIndicator } from "@/components/realtime-status-indicator"
import { useRealtimeData } from "@/hooks/use-realtime-data"

export function AppSidebar() {
  const pathname = usePathname()
  const { status: realtimeStatus } = useRealtimeData('requests', { enabled: true })

  return (
    <Sidebar collapsible="icon">
      <SidebarHeader>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton asChild isActive={pathname === '/'}>
              <Link href="/" className="font-bold">
                <Home className="!opacity-100" />
                <span className="font-bold">Jinn Explorer</span>
              </Link>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>
      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupContent>
            <SidebarMenu>
              {navigationItems.map((item) => {
                const isActive = pathname === `/${item.collection}` ||
                  (item.subItems?.some(subItem => pathname.startsWith(`/${subItem.collection}`)))

                if (item.subItems) {
                  // Collapsible item with sub-items
                  const ParentIcon = item.collection === 'ecosystem' ? Rocket
                    : item.collection === 'work' ? Briefcase
                    : item.collection === 'nodes' ? Server
                    : item.collection === 'network' ? Server
                    : Briefcase
                  return (
                    <Collapsible
                      key={item.collection}
                      defaultOpen={true}
                      className="group/collapsible"
                    >
                      <SidebarMenuItem>
                        <CollapsibleTrigger asChild>
                          <SidebarMenuButton isActive={isActive}>
                            <ParentIcon />
                            <span>{item.label}</span>
                            <ChevronRight className="ml-auto transition-transform group-data-[state=open]/collapsible:rotate-90" />
                          </SidebarMenuButton>
                        </CollapsibleTrigger>
                        <CollapsibleContent>
                          <SidebarMenuSub>
                            {item.subItems.map((subItem) => {
                              const isSubItemActive = pathname.startsWith(`/${subItem.collection}`)
                              return (
                                <SidebarMenuSubItem key={subItem.collection}>
                                  <SidebarMenuSubButton
                                    asChild
                                    isActive={isSubItemActive}
                                  >
                                    <Link href={`/${subItem.collection}`}>
                                      <span>{subItem.label}</span>
                                    </Link>
                                  </SidebarMenuSubButton>
                                </SidebarMenuSubItem>
                              )
                            })}
                          </SidebarMenuSub>
                        </CollapsibleContent>
                      </SidebarMenuItem>
                    </Collapsible>
                  )
                }

                // Regular menu item without sub-items
                const Icon = item.collection === 'ventures' ? Rocket
                  : item.collection === 'services' ? Layers
                  : item.collection === 'workstreams' ? Workflow
                  : item.collection === 'nodes' ? Server
                  : FileText
                return (
                  <SidebarMenuItem key={item.collection}>
                    <SidebarMenuButton asChild isActive={isActive}>
                      <Link href={`/${item.collection}`}>
                        <Icon />
                        <span>{item.label}</span>
                      </Link>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                )
              })}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>
      <SidebarFooter>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton asChild>
              <a href="https://www.jinn.network" target="_blank" rel="noopener noreferrer">
                <Info />
                <span>About Jinn</span>
              </a>
            </SidebarMenuButton>
          </SidebarMenuItem>
          <SidebarMenuItem>
            <SidebarMenuButton asChild>
              <a href="https://docs.jinn.network" target="_blank" rel="noopener noreferrer">
                <BookOpen />
                <span>Documentation</span>
              </a>
            </SidebarMenuButton>
          </SidebarMenuItem>
          <SidebarMenuItem>
            <SidebarMenuButton asChild>
              <a href="https://blog.jinn.network" target="_blank" rel="noopener noreferrer">
                <Newspaper />
                <span>Blog</span>
              </a>
            </SidebarMenuButton>
          </SidebarMenuItem>
          <SidebarMenuItem>
            <SidebarMenuButton asChild>
              <a href="https://github.com/jinn-network" target="_blank" rel="noopener noreferrer">
                <Github />
                <span>GitHub</span>
              </a>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
        <div className="flex items-center justify-between px-2 py-1 group-data-[collapsible=icon]:flex-col group-data-[collapsible=icon]:gap-2 group-data-[collapsible=icon]:justify-center group-data-[collapsible=icon]:px-0">
          <div className="flex items-center [&_span]:group-data-[collapsible=icon]:hidden">
            <RealtimeStatusIndicator status={realtimeStatus} />
          </div>
          <ThemeToggle />
        </div>
      </SidebarFooter>
      <SidebarRail />
    </Sidebar>
  )
}

