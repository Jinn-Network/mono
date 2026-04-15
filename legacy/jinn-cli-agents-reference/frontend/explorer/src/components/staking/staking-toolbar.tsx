'use client'

import { useRouter, useSearchParams } from 'next/navigation'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { STAKING_CONTRACTS } from '@/lib/staking/constants'

interface StakingToolbarProps {
  viewMode: 'table' | 'cards'
  owners: { address: string; label: string }[]
  selectedOwner: string | null
  selectedContract: string | null
}

export function StakingToolbar({ viewMode, owners, selectedOwner, selectedContract }: StakingToolbarProps) {
  const router = useRouter()
  const searchParams = useSearchParams()

  function navigate(params: Record<string, string | null>) {
    const next = new URLSearchParams(searchParams.toString())
    for (const [key, value] of Object.entries(params)) {
      if (value === null) {
        next.delete(key)
      } else {
        next.set(key, value)
      }
    }
    const qs = next.toString()
    router.push(`/nodes/staking${qs ? `?${qs}` : ''}`)
  }

  return (
    <div className="flex items-center justify-between gap-4">
      <div className="flex items-center gap-3">
        <Tabs
          value={viewMode}
          onValueChange={(v) => navigate({ view: v === 'table' ? null : v })}
        >
          <TabsList>
            <TabsTrigger value="table">Table</TabsTrigger>
            <TabsTrigger value="cards">Cards</TabsTrigger>
          </TabsList>
        </Tabs>

        <div className="flex items-center gap-1">
          <button
            onClick={() => navigate({ contract: null })}
            className={`px-2.5 py-1 text-xs rounded-md border transition-colors ${
              !selectedContract
                ? 'bg-primary text-primary-foreground border-primary'
                : 'bg-muted text-muted-foreground border-border hover:bg-accent'
            }`}
          >
            All
          </button>
          {STAKING_CONTRACTS.map(c => (
            <button
              key={c.shortKey}
              onClick={() => navigate({ contract: selectedContract === c.shortKey ? null : c.shortKey })}
              className={`px-2.5 py-1 text-xs rounded-md border transition-colors ${
                selectedContract === c.shortKey
                  ? 'bg-primary text-primary-foreground border-primary'
                  : 'bg-muted text-muted-foreground border-border hover:bg-accent'
              }`}
            >
              {c.label}
            </button>
          ))}
        </div>
      </div>

      {owners.length > 1 && (
        <Select
          value={selectedOwner ?? 'all'}
          onValueChange={(v) => navigate({ owner: v === 'all' ? null : v })}
        >
          <SelectTrigger size="sm">
            <SelectValue placeholder="Filter by owner" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All owners</SelectItem>
            {owners.map((o) => (
              <SelectItem key={o.address} value={o.address}>
                {o.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      )}
    </div>
  )
}
