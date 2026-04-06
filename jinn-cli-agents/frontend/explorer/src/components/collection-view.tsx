'use client'

import { useState, useMemo, useEffect, useRef } from 'react'
import { useSearchParams, useRouter } from 'next/navigation'
import { Filter, X } from 'lucide-react'
import { CollectionName } from '@/lib/types'
import { RecordList } from '@/components/record-list'
import { RequestsTable } from '@/components/requests-table'
import { ArtifactsTable } from '@/components/artifacts-table'
import { JobDefinitionsTable } from '@/components/job-definitions-table'
import { Pagination } from '@/components/pagination'
import { RecordListSkeleton, RequestsTableSkeleton, ArtifactsTableSkeleton, JobDefinitionsTableSkeleton } from '@/components/loading-skeleton'
import { getCollectionLabel } from '@/lib/utils'
import { useSubgraphCollection } from '@/hooks/use-subgraph-collection'
import {
  getRequest,
  queryJobDefinitionsByName,
  queryJobTemplateIdsByName,
  queryWorkstreamIdsByName,
  Request,
} from '@/lib/subgraph'
import { SiteHeader } from '@/components/site-header'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Label } from '@/components/ui/label'
import { Badge } from '@/components/ui/badge'

interface CollectionViewProps {
  collectionName: CollectionName
}

function getSortingConfig(collectionName: CollectionName): { column: string; ascending: boolean } {
  const sortingConfigs: Record<CollectionName, { column: string; ascending: boolean }> = {
    jobDefinitions: { column: 'lastInteraction', ascending: false },
    requests: { column: 'blockTimestamp', ascending: false },
    deliveries: { column: 'blockTimestamp', ascending: false },
    artifacts: { column: 'blockTimestamp', ascending: false },
    messages: { column: 'blockTimestamp', ascending: false },
    templates: { column: 'id', ascending: false },
    workstreams: { column: 'lastActivity', ascending: false },
  }

  return sortingConfigs[collectionName] || { column: 'id', ascending: false }
}

type FilterType =
  | 'jobRunId'
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

interface FilterOption {
  value: FilterType
  label: string
}

interface CollectionFilterConfig {
  defaultType: FilterType
  options: FilterOption[]
  urlParamMap: Record<FilterType, string>
}

const REQUEST_FILTER_OPTIONS: FilterOption[] = [
  { value: 'workstreamId', label: 'Workstream ID' },
  { value: 'workstreamName', label: 'Workstream Name' },
  { value: 'jobInstanceId', label: 'Job Instance ID' },
  { value: 'jobInstanceName', label: 'Job Instance Name' },
  { value: 'templateId', label: 'Template ID' },
  { value: 'templateName', label: 'Template Name' },
  { value: 'jobRunId', label: 'Job Run ID' },
]

const JOB_DEFINITION_FILTER_OPTIONS: FilterOption[] = [
  { value: 'jobInstanceId', label: 'Job Instance ID' },
  { value: 'jobInstanceName', label: 'Job Instance Name' },
  { value: 'workstreamId', label: 'Workstream ID' },
  { value: 'workstreamName', label: 'Workstream Name' },
  { value: 'templateId', label: 'Template ID' },
  { value: 'templateName', label: 'Template Name' },
]

const FILTER_CONFIGS: Partial<Record<CollectionName, CollectionFilterConfig>> = {
  requests: {
    defaultType: 'workstreamId',
    options: REQUEST_FILTER_OPTIONS,
    urlParamMap: {
      jobRunId: 'id',
      workstreamId: 'workstream',
      workstreamName: 'workstreamName',
      jobInstanceId: 'jobInstanceId',
      jobInstanceName: 'jobInstanceName',
      templateId: 'templateId',
      templateName: 'templateName',
    },
  },
  jobDefinitions: {
    defaultType: 'jobInstanceId',
    options: JOB_DEFINITION_FILTER_OPTIONS,
    urlParamMap: {
      jobRunId: 'id',
      workstreamId: 'workstream',
      workstreamName: 'workstreamName',
      jobInstanceId: 'jobInstanceId',
      jobInstanceName: 'jobInstanceName',
      templateId: 'templateId',
      templateName: 'templateName',
    },
  },
}

const FILTER_LABELS: Record<FilterType, string> = {
  jobRunId: 'Job Run ID',
  workstreamId: 'Workstream ID',
  workstreamName: 'Workstream Name',
  jobInstanceId: 'Job Instance ID',
  jobInstanceName: 'Job Instance Name',
  templateId: 'Template ID',
  templateName: 'Template Name',
}

const ID_FILTER_TYPES = new Set<FilterType>(['jobRunId', 'workstreamId', 'jobInstanceId', 'templateId'])
const NO_MATCH_FILTER = '__no_match__'
const HEX_32_BYTE_REGEX = /^0x[a-fA-F0-9]{64}$/

function makeFilterLabel(type: FilterType, value: string): string {
  const display = ID_FILTER_TYPES.has(type) && value.length > 16
    ? `${value.slice(0, 16)}…`
    : value
  return `${FILTER_LABELS[type]}: ${display}`
}

function getFilterConfig(collectionName: CollectionName): CollectionFilterConfig | null {
  return FILTER_CONFIGS[collectionName] ?? null
}

export function CollectionView({ collectionName }: CollectionViewProps) {
  const router = useRouter()
  const searchParams = useSearchParams()

  const filterConfig = getFilterConfig(collectionName)
  const [rootRequest, setRootRequest] = useState<Request | null>(null)
  const [whereFilter, setWhereFilter] = useState<Record<string, unknown> | undefined>()
  const [isResolvingFilters, setIsResolvingFilters] = useState(false)
  const pageSize = 100

  const [activeFilters, setActiveFilters] = useState<ActiveFilter[]>([])
  const [filterType, setFilterType] = useState<FilterType>(filterConfig?.defaultType ?? 'jobRunId')
  const [filterValue, setFilterValue] = useState('')
  const [popoverOpen, setPopoverOpen] = useState(false)
  const [isInitialized, setIsInitialized] = useState(false)

  useEffect(() => {
    if (!filterConfig) {
      setIsInitialized(true)
      return
    }

    if (!filterConfig.options.some(option => option.value === filterType)) {
      setFilterType(filterConfig.defaultType)
    }
  }, [filterConfig, filterType])

  useEffect(() => {
    if (isInitialized) return

    if (!filterConfig) {
      setIsInitialized(true)
      return
    }

    const filters: ActiveFilter[] = []

    for (const option of filterConfig.options) {
      const param = filterConfig.urlParamMap[option.value]
      const value = param ? searchParams.get(param) : null
      if (value) {
        filters.push({
          type: option.value,
          value,
          label: makeFilterLabel(option.value, value),
        })
      }
    }

    if (filters.length > 0) {
      setActiveFilters(filters)
    }

    setIsInitialized(true)
  }, [filterConfig, searchParams, isInitialized])

  const lastSyncedFiltersRef = useRef<string>('')

  useEffect(() => {
    if (!isInitialized || !filterConfig) return

    const filterKey = JSON.stringify(activeFilters)
    if (filterKey === lastSyncedFiltersRef.current) return
    lastSyncedFiltersRef.current = filterKey

    const params = new URLSearchParams(searchParams.toString())

    for (const param of Object.values(filterConfig.urlParamMap)) {
      params.delete(param)
    }

    activeFilters.forEach(filter => {
      const param = filterConfig.urlParamMap[filter.type]
      if (param) {
        params.set(param, filter.value)
      }
    })

    const newUrl = params.toString() ? `?${params.toString()}` : window.location.pathname
    router.replace(newUrl, { scroll: false })
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeFilters, isInitialized, filterConfig])

  const exactWorkstreamId = useMemo(() => {
    if (collectionName !== 'requests') return null

    const candidate = activeFilters.find(filter => filter.type === 'workstreamId')?.value.trim()
    if (!candidate || !HEX_32_BYTE_REGEX.test(candidate)) return null

    return candidate
  }, [collectionName, activeFilters])

  useEffect(() => {
    if (collectionName !== 'requests' || !exactWorkstreamId) {
      setRootRequest(null)
      return
    }

    getRequest(exactWorkstreamId).then(setRootRequest).catch(() => setRootRequest(null))
  }, [collectionName, exactWorkstreamId])

  useEffect(() => {
    let isCancelled = false

    async function buildWhereFilter() {
      if (!filterConfig || activeFilters.length === 0) {
        if (!isCancelled) {
          setWhereFilter(undefined)
          setIsResolvingFilters(false)
        }
        return
      }

      const nextFilter: Record<string, unknown> = {}
      const filterMap = new Map(activeFilters.map(filter => [filter.type, filter.value.trim()]))

      if (collectionName === 'requests') {
        const jobRunId = filterMap.get('jobRunId')
        const workstreamId = filterMap.get('workstreamId')
        const jobInstanceId = filterMap.get('jobInstanceId')
        const templateId = filterMap.get('templateId')

        if (jobRunId) nextFilter.id_contains = jobRunId
        if (workstreamId) nextFilter.workstreamId_contains = workstreamId
        if (jobInstanceId) nextFilter.jobDefinitionId_contains = jobInstanceId
        if (templateId) nextFilter.templateId_contains = templateId

        const pendingLookups: Array<Promise<void>> = []
        let noMatches = false

        const workstreamName = filterMap.get('workstreamName')
        if (workstreamName) {
          pendingLookups.push((async () => {
            const ids = await queryWorkstreamIdsByName(workstreamName)
            if (ids.length === 0) {
              noMatches = true
              return
            }
            nextFilter.workstreamId_in = ids
          })())
        }

        const jobInstanceName = filterMap.get('jobInstanceName')
        if (jobInstanceName) {
          pendingLookups.push((async () => {
            const defs = await queryJobDefinitionsByName(jobInstanceName)
            const ids = defs.map(def => def.id)
            if (ids.length === 0) {
              noMatches = true
              return
            }
            nextFilter.jobDefinitionId_in = ids
          })())
        }

        const templateName = filterMap.get('templateName')
        if (templateName) {
          pendingLookups.push((async () => {
            const ids = await queryJobTemplateIdsByName(templateName)
            if (ids.length === 0) {
              noMatches = true
              return
            }
            nextFilter.templateId_in = ids
          })())
        }

        setIsResolvingFilters(pendingLookups.length > 0)
        await Promise.all(pendingLookups)

        if (noMatches) {
          nextFilter.id = NO_MATCH_FILTER
        }
      }

      if (collectionName === 'jobDefinitions') {
        const jobInstanceId = filterMap.get('jobInstanceId')
        const jobInstanceName = filterMap.get('jobInstanceName')
        const workstreamId = filterMap.get('workstreamId')
        const templateId = filterMap.get('templateId')

        if (jobInstanceId) nextFilter.id_contains = jobInstanceId
        if (jobInstanceName) nextFilter.name_contains = jobInstanceName
        if (workstreamId) nextFilter.workstreamId_contains = workstreamId
        if (templateId) nextFilter.templateId_contains = templateId

        const pendingLookups: Array<Promise<void>> = []
        let noMatches = false

        const workstreamName = filterMap.get('workstreamName')
        if (workstreamName) {
          pendingLookups.push((async () => {
            const ids = await queryWorkstreamIdsByName(workstreamName)
            if (ids.length === 0) {
              noMatches = true
              return
            }
            nextFilter.workstreamId_in = ids
          })())
        }

        const templateName = filterMap.get('templateName')
        if (templateName) {
          pendingLookups.push((async () => {
            const ids = await queryJobTemplateIdsByName(templateName)
            if (ids.length === 0) {
              noMatches = true
              return
            }
            nextFilter.templateId_in = ids
          })())
        }

        setIsResolvingFilters(pendingLookups.length > 0)
        await Promise.all(pendingLookups)

        if (noMatches) {
          nextFilter.id = NO_MATCH_FILTER
        }
      }

      if (!isCancelled) {
        setWhereFilter(Object.keys(nextFilter).length > 0 ? nextFilter : undefined)
        setIsResolvingFilters(false)
      }
    }

    buildWhereFilter().catch(() => {
      if (!isCancelled) {
        setWhereFilter({ id: NO_MATCH_FILTER })
        setIsResolvingFilters(false)
      }
    })

    return () => {
      isCancelled = true
    }
  }, [collectionName, activeFilters, filterConfig])

  const handleAddFilter = () => {
    if (!filterConfig || !filterValue.trim()) return

    const value = filterValue.trim()

    setActiveFilters(prev => [
      ...prev.filter(filter => filter.type !== filterType),
      {
        type: filterType,
        value,
        label: makeFilterLabel(filterType, value),
      },
    ])

    setFilterValue('')
    setPopoverOpen(false)
  }

  const handleRemoveFilter = (filterToRemove: ActiveFilter) => {
    setActiveFilters(prev => prev.filter(filter => filter !== filterToRemove))
  }

  const sortConfig = getSortingConfig(collectionName)
  const {
    records,
    loading,
    totalRecords,
    currentPage,
    setCurrentPage,
    error,
    hasNextPage,
    hasPreviousPage,
    setSorting,
    sortColumn,
    sortAscending,
  } = useSubgraphCollection({
    collectionName,
    pageSize,
    enablePolling: true,
    pollingInterval: 10000,
    sortColumn: sortConfig.column,
    sortAscending: sortConfig.ascending,
    whereFilter,
  })

  const handleSort = (column: string, direction: 'asc' | 'desc') => {
    setSorting(column, direction === 'asc')
  }

  const displayRecords = useMemo(() => {
    if (rootRequest && collectionName === 'requests' && exactWorkstreamId) {
      const withoutRoot = records.filter(record => record.id !== rootRequest.id)
      return [rootRequest, ...withoutRoot]
    }
    return records
  }, [rootRequest, records, collectionName, exactWorkstreamId])

  const currentFilterLabel = filterConfig?.options.find(option => option.value === filterType)?.label
  const breadcrumbs = [{ label: getCollectionLabel(collectionName) }]

  if (loading) {
    const getSkeletonForCollection = () => {
      switch (collectionName) {
        case 'requests':
          return <RequestsTableSkeleton />
        case 'artifacts':
          return <ArtifactsTableSkeleton />
        case 'jobDefinitions':
          return <JobDefinitionsTableSkeleton />
        default:
          return <RecordListSkeleton />
      }
    }

    return (
      <>
        <SiteHeader breadcrumbs={breadcrumbs} />
        <div className="p-4 md:p-6">
          {getSkeletonForCollection()}
        </div>
      </>
    )
  }

  if (error) {
    return (
      <>
        <SiteHeader breadcrumbs={breadcrumbs} />
        <div className="p-4 md:p-6">
          <div className="text-red-700 dark:text-red-400 p-4 border border-red-500/30 rounded bg-red-500/10">
            Error loading {collectionName}: {error}
          </div>
        </div>
      </>
    )
  }

  return (
    <>
      <SiteHeader breadcrumbs={breadcrumbs} />
      <div className="p-4 md:p-6">
        {filterConfig && (
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
                        {filterConfig.options.map(option => (
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
        )}

        {collectionName === 'requests' ? (
          <RequestsTable records={displayRecords} />
        ) : collectionName === 'artifacts' ? (
          <ArtifactsTable records={displayRecords} />
        ) : collectionName === 'jobDefinitions' ? (
          <JobDefinitionsTable
            records={displayRecords}
            onSort={handleSort}
            sortColumn={sortColumn}
            sortAscending={sortAscending}
          />
        ) : (
          <RecordList records={displayRecords} collectionName={collectionName} />
        )}

        <Pagination
          currentPage={currentPage}
          totalRecords={totalRecords}
          pageSize={pageSize}
          onPageChange={setCurrentPage}
          hasNextPage={hasNextPage}
          hasPreviousPage={hasPreviousPage}
        />
      </div>
    </>
  )
}
