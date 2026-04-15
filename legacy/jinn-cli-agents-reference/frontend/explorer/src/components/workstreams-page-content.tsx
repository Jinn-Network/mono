'use client'

import { useState, useEffect, useRef } from 'react'
import { useSearchParams, useRouter } from 'next/navigation'
import { Filter, X } from 'lucide-react'
import { WorkstreamsTable } from '@/components/workstreams-table'
import { Pagination } from '@/components/pagination'
import { useSubgraphCollection } from '@/hooks/use-subgraph-collection'
import { SiteHeader } from '@/components/site-header'
import {
  queryJobDefinitions,
  queryJobDefinitionsByName,
  queryJobTemplateIdsByName,
} from '@/lib/subgraph'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Label } from '@/components/ui/label'
import { Badge } from '@/components/ui/badge'

type FilterType =
  | 'workstreamId'
  | 'workstreamName'
  | 'jobInstanceId'
  | 'jobInstanceName'
  | 'templateId'
  | 'templateName'

interface ActiveFilter {
  type: FilterType
  value: string
  label: string
}

const FILTER_OPTIONS: Array<{ value: FilterType; label: string }> = [
  { value: 'workstreamId', label: 'Workstream ID' },
  { value: 'workstreamName', label: 'Workstream Name' },
  { value: 'jobInstanceId', label: 'Job Instance ID' },
  { value: 'jobInstanceName', label: 'Job Instance Name' },
  { value: 'templateId', label: 'Template ID' },
  { value: 'templateName', label: 'Template Name' },
]

const FILTER_LABELS: Record<FilterType, string> = {
  workstreamId: 'Workstream ID',
  workstreamName: 'Workstream Name',
  jobInstanceId: 'Job Instance ID',
  jobInstanceName: 'Job Instance Name',
  templateId: 'Template ID',
  templateName: 'Template Name',
}

const URL_PARAM_MAP: Record<FilterType, string> = {
  workstreamId: 'workstreamId',
  workstreamName: 'workstreamName',
  jobInstanceId: 'jobInstanceId',
  jobInstanceName: 'jobInstanceName',
  templateId: 'templateId',
  templateName: 'templateName',
}

const URL_PARAM_REVERSE: Record<string, FilterType> = Object.fromEntries(
  Object.entries(URL_PARAM_MAP).map(([type, param]) => [param, type as FilterType])
)

const ID_FILTER_TYPES = new Set<FilterType>(['workstreamId', 'jobInstanceId', 'templateId'])
const NO_MATCH_FILTER = '__no_match__'

function makeFilterLabel(type: FilterType, value: string): string {
  const display = ID_FILTER_TYPES.has(type) && value.length > 16
    ? `${value.slice(0, 16)}…`
    : value
  return `${FILTER_LABELS[type]}: ${display}`
}

function normalizeIds(values: Array<string | undefined | null>): string[] {
  return [...new Set(values.filter((value): value is string => Boolean(value)))]
}

function mergeIntersection(current: string[] | undefined, incoming: string[]): string[] {
  if (!current) return incoming
  return current.filter(id => incoming.includes(id))
}

export function WorkstreamsPageContent() {
  const router = useRouter()
  const searchParams = useSearchParams()
  const pageSize = 50

  const [activeFilters, setActiveFilters] = useState<ActiveFilter[]>([])
  const [filterType, setFilterType] = useState<FilterType>('workstreamId')
  const [filterValue, setFilterValue] = useState('')
  const [popoverOpen, setPopoverOpen] = useState(false)
  const [isInitialized, setIsInitialized] = useState(false)
  const [whereFilter, setWhereFilter] = useState<Record<string, unknown> | undefined>()
  const [isResolvingFilters, setIsResolvingFilters] = useState(false)

  useEffect(() => {
    if (isInitialized) return

    const filters: ActiveFilter[] = []

    for (const [param, type] of Object.entries(URL_PARAM_REVERSE)) {
      const value = searchParams.get(param)
      if (value) {
        filters.push({ type, value, label: makeFilterLabel(type, value) })
      }
    }

    if (filters.length > 0) {
      setActiveFilters(filters)
    }

    setIsInitialized(true)
  }, [searchParams, isInitialized])

  const lastSyncedFiltersRef = useRef<string>('')

  useEffect(() => {
    if (!isInitialized) return

    const filterKey = JSON.stringify(activeFilters)
    if (filterKey === lastSyncedFiltersRef.current) return
    lastSyncedFiltersRef.current = filterKey

    const params = new URLSearchParams(searchParams.toString())

    Object.values(URL_PARAM_MAP).forEach(param => params.delete(param))

    activeFilters.forEach(filter => {
      params.set(URL_PARAM_MAP[filter.type], filter.value)
    })

    const newUrl = params.toString() ? `?${params.toString()}` : window.location.pathname
    router.replace(newUrl, { scroll: false })
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeFilters, isInitialized])

  useEffect(() => {
    let isCancelled = false

    async function buildWhereFilter() {
      if (activeFilters.length === 0) {
        if (!isCancelled) {
          setWhereFilter(undefined)
          setIsResolvingFilters(false)
        }
        return
      }

      const nextFilter: Record<string, unknown> = {}
      const filterMap = new Map(activeFilters.map(filter => [filter.type, filter.value.trim()]))

      const workstreamId = filterMap.get('workstreamId')
      const workstreamName = filterMap.get('workstreamName')
      const templateId = filterMap.get('templateId')

      if (workstreamId) nextFilter.id_contains = workstreamId
      if (workstreamName) nextFilter.jobName_contains = workstreamName
      if (templateId) nextFilter.templateId_contains = templateId

      let candidateWorkstreamIds: string[] | undefined
      let noMatches = false

      const jobInstanceId = filterMap.get('jobInstanceId')
      if (jobInstanceId) {
        const jobDefinitions = await queryJobDefinitions({
          where: { id_contains: jobInstanceId },
          limit: 200,
          orderBy: 'lastInteraction',
          orderDirection: 'desc',
        })
        const workstreamIds = normalizeIds(jobDefinitions.items.map(item => item.workstreamId))
        if (workstreamIds.length === 0) {
          noMatches = true
        } else {
          candidateWorkstreamIds = mergeIntersection(candidateWorkstreamIds, workstreamIds)
        }
      }

      const jobInstanceName = filterMap.get('jobInstanceName')
      if (jobInstanceName) {
        const jobDefinitions = await queryJobDefinitionsByName(jobInstanceName)
        const workstreamIds = normalizeIds(jobDefinitions.map(item => item.workstreamId))
        if (workstreamIds.length === 0) {
          noMatches = true
        } else {
          candidateWorkstreamIds = mergeIntersection(candidateWorkstreamIds, workstreamIds)
        }
      }

      if (candidateWorkstreamIds && candidateWorkstreamIds.length === 0) {
        noMatches = true
      }

      if (candidateWorkstreamIds && candidateWorkstreamIds.length > 0) {
        nextFilter.id_in = candidateWorkstreamIds
      }

      const templateName = filterMap.get('templateName')
      if (templateName) {
        const templateIds = await queryJobTemplateIdsByName(templateName)
        if (templateIds.length === 0) {
          noMatches = true
        } else {
          nextFilter.templateId_in = templateIds
        }
      }

      if (noMatches) {
        nextFilter.id = NO_MATCH_FILTER
      }

      if (!isCancelled) {
        setWhereFilter(Object.keys(nextFilter).length > 0 ? nextFilter : undefined)
        setIsResolvingFilters(false)
      }
    }

    setIsResolvingFilters(true)
    buildWhereFilter().catch(() => {
      if (!isCancelled) {
        setWhereFilter({ id: NO_MATCH_FILTER })
        setIsResolvingFilters(false)
      }
    })

    return () => {
      isCancelled = true
    }
  }, [activeFilters])

  const handleAddFilter = () => {
    if (!filterValue.trim()) return

    const value = filterValue.trim()
    setActiveFilters(prev => [
      ...prev.filter(filter => filter.type !== filterType),
      { type: filterType, value, label: makeFilterLabel(filterType, value) },
    ])

    setFilterValue('')
    setPopoverOpen(false)
  }

  const handleRemoveFilter = (filterToRemove: ActiveFilter) => {
    setActiveFilters(prev => prev.filter(filter => filter !== filterToRemove))
  }

  const {
    records,
    loading,
    totalRecords,
    currentPage,
    setCurrentPage,
    error,
    hasNextPage,
    hasPreviousPage,
  } = useSubgraphCollection({
    collectionName: 'workstreams',
    pageSize,
    enablePolling: true,
    pollingInterval: 10000,
    sortColumn: 'lastActivity',
    sortAscending: false,
    whereFilter,
  })

  const currentFilterLabel = FILTER_OPTIONS.find(option => option.value === filterType)?.label
  const breadcrumbs = [{ label: 'Workstreams' }]

  return (
    <>
      <SiteHeader
        subtitle="Top-level job executions and their entire downstream graphs"
        breadcrumbs={breadcrumbs}
      />
      <div className="p-4 md:p-6">
        <div className="mb-4 flex items-center gap-2 flex-wrap">
          <Popover open={popoverOpen} onOpenChange={setPopoverOpen}>
            <PopoverTrigger asChild>
              <Button variant="outline" size="sm" className="gap-2">
                <Filter className="h-4 w-4" aria-hidden="true" />
                Filter
              </Button>
            </PopoverTrigger>
            <PopoverContent
              className="w-80"
              align="start"
              onEscapeKeyDown={() => setPopoverOpen(false)}
            >
              <div className="space-y-4">
                <div className="space-y-2">
                  <Label htmlFor="filter-type">Filter Type</Label>
                  <Select value={filterType} onValueChange={(value) => setFilterType(value as FilterType)}>
                    <SelectTrigger id="filter-type" className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {FILTER_OPTIONS.map(option => (
                        <SelectItem key={option.value} value={option.value}>
                          {option.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-2">
                  <Label htmlFor="filter-value">Value</Label>
                  <Input
                    id="filter-value"
                    name="filter-value"
                    autoComplete="off"
                    placeholder={`Enter ${currentFilterLabel ?? 'value'}…`}
                    value={filterValue}
                    onChange={(event) => setFilterValue(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') {
                        handleAddFilter()
                      } else if (event.key === 'Escape') {
                        setPopoverOpen(false)
                      }
                    }}
                  />
                </div>
                <div className="flex gap-2">
                  <Button
                    variant="outline"
                    onClick={() => setPopoverOpen(false)}
                    className="flex-1"
                    size="sm"
                  >
                    Cancel
                  </Button>
                  <Button
                    onClick={handleAddFilter}
                    className="flex-1"
                    size="sm"
                  >
                    Add Filter
                  </Button>
                </div>
              </div>
            </PopoverContent>
          </Popover>

          {activeFilters.map((filter, index) => (
            <Badge
              key={index}
              variant="outline"
              className="gap-1.5 bg-primary/10 border-primary/30 text-primary"
            >
              <span>{filter.label}</span>
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={`Remove filter: ${filter.label}`}
                className="hover:bg-transparent"
                onClick={() => handleRemoveFilter(filter)}
              >
                <X className="h-3 w-3" aria-hidden="true" />
              </Button>
            </Badge>
          ))}

          {isResolvingFilters && (
            <span aria-live="polite" className="text-sm text-muted-foreground">Applying filters…</span>
          )}
        </div>

        {loading ? (
          <div className="text-center py-12 text-muted-foreground">
            Loading workstreams…
          </div>
        ) : error ? (
          <div className="text-red-700 dark:text-red-400 p-4 border border-red-500/30 rounded bg-red-500/10">
            Error loading workstreams: {error}
          </div>
        ) : (
          <>
            <WorkstreamsTable records={records} />
            <Pagination
              currentPage={currentPage}
              totalRecords={totalRecords}
              pageSize={pageSize}
              onPageChange={setCurrentPage}
              hasNextPage={hasNextPage}
              hasPreviousPage={hasPreviousPage}
            />
          </>
        )}
      </div>
    </>
  )
}
