import {
  Pagination as PaginationRoot,
  PaginationContent,
  PaginationEllipsis,
  PaginationItem,
  PaginationLink,
  PaginationNext,
  PaginationPrevious,
} from '@/components/ui/pagination'

interface PaginationProps {
  currentPage: number
  totalRecords: number
  pageSize: number
  onPageChange: (page: number) => void
  hasNextPage?: boolean
  hasPreviousPage?: boolean
}

export function Pagination({ currentPage, totalRecords, pageSize, onPageChange, hasNextPage = false, hasPreviousPage = false }: PaginationProps) {
  const totalPages = Math.ceil(totalRecords / pageSize)
  const hasNext = hasNextPage || currentPage < totalPages
  const hasPrev = hasPreviousPage || currentPage > 1

  if (totalPages <= 1 && !hasNext) {
    return null
  }

  const startRecord = ((currentPage - 1) * pageSize) + 1
  const endRecord = Math.min(currentPage * pageSize, totalRecords)
  
  // Generate page numbers to display
  const getPageNumbers = () => {
    const pages: (number | 'ellipsis')[] = []
    const maxVisible = 5
    
    if (totalPages <= maxVisible) {
      // Show all pages
      for (let i = 1; i <= totalPages; i++) {
        pages.push(i)
      }
    } else {
      // Always show first page
      pages.push(1)
      
      if (currentPage > 3) {
        pages.push('ellipsis')
      }
      
      // Show pages around current page
      const start = Math.max(2, currentPage - 1)
      const end = Math.min(totalPages - 1, currentPage + 1)
      
      for (let i = start; i <= end; i++) {
        pages.push(i)
      }
      
      if (currentPage < totalPages - 2) {
        pages.push('ellipsis')
      }
      
      // Always show last page
      pages.push(totalPages)
    }
    
    return pages
  }
  
  return (
    <div className="flex items-center justify-between px-2 py-4 gap-4">
      <div className="text-sm text-muted-foreground whitespace-nowrap flex-shrink-0">
        Showing {startRecord} to {endRecord}{hasNextPage ? '+' : ''} of {hasNextPage ? `${totalRecords}+` : totalRecords} records
      </div>
      
      <PaginationRoot className="ml-auto">
        <PaginationContent>
          <PaginationItem>
            <PaginationPrevious
              onClick={(e) => {
                e.preventDefault()
                if (hasPrev) onPageChange(currentPage - 1)
              }}
              aria-disabled={!hasPrev}
              className={!hasPrev ? 'pointer-events-none opacity-50' : 'cursor-pointer'}
            />
          </PaginationItem>
          
          {getPageNumbers().map((page, index) => (
            <PaginationItem key={`${page}-${index}`}>
              {page === 'ellipsis' ? (
                <PaginationEllipsis />
              ) : (
                <PaginationLink
                  onClick={(e) => {
                    e.preventDefault()
                    onPageChange(page)
                  }}
                  isActive={page === currentPage}
                  className="cursor-pointer"
                >
                  {page}
                </PaginationLink>
              )}
            </PaginationItem>
          ))}
          
          <PaginationItem>
            <PaginationNext
              onClick={(e) => {
                e.preventDefault()
                if (hasNext) onPageChange(currentPage + 1)
              }}
              aria-disabled={!hasNext}
              className={!hasNext ? 'pointer-events-none opacity-50' : 'cursor-pointer'}
            />
          </PaginationItem>
        </PaginationContent>
      </PaginationRoot>
    </div>
  )
}
