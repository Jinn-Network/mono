'use client'

import { Button } from '@/components/ui/button'
import { ArrowLeftRight, ArrowUpDown } from 'lucide-react'

interface GraphControlsProps {
  onZoomIn: () => void
  onZoomOut: () => void
  onFitView: () => void
  onToggleLayout: () => void
  layout: 'TB' | 'LR'
  currentDepth: number
  onDepthChange: (depth: number) => void
  direction: 'upstream' | 'downstream' | 'both'
  onDirectionChange: (direction: 'upstream' | 'downstream' | 'both') => void
}

export function GraphControls({
  onZoomIn,
  onZoomOut,
  onFitView,
  onToggleLayout,
  layout,
  currentDepth,
  onDepthChange,
  direction,
  onDirectionChange,
}: GraphControlsProps) {
  return (
    <div className="absolute top-4 right-4 bg-card rounded-lg shadow-lg p-4 space-y-4 z-10 min-w-[200px]">
      {/* Zoom controls */}
      <div className="space-y-2">
        <div className="text-xs font-semibold text-gray-400 uppercase">View</div>
        <div className="flex gap-2">
          <Button onClick={onZoomIn} size="sm" variant="outline" className="flex-1">
            +
          </Button>
          <Button onClick={onZoomOut} size="sm" variant="outline" className="flex-1">
            −
          </Button>
          <Button onClick={onFitView} size="sm" variant="outline" className="flex-1">
            Fit
          </Button>
        </div>
      </div>

      {/* Depth slider */}
      <div className="space-y-2">
        <div className="text-xs font-semibold text-gray-400 uppercase">
          Depth: <span className="text-primary">{currentDepth}</span>
        </div>
        <input
          type="range"
          min="1"
          max="5"
          value={currentDepth}
          onChange={(e) => onDepthChange(Number(e.target.value))}
          className="w-full h-2 bg-gray-200 rounded-lg appearance-none cursor-pointer accent-blue-600"
        />
        <div className="flex justify-between text-xs text-gray-500">
          <span>1</span>
          <span>5</span>
        </div>
      </div>

      {/* Direction select */}
      <div className="space-y-2">
        <div className="text-xs font-semibold text-gray-400 uppercase">Direction</div>
        <select
          value={direction}
          onChange={(e) => onDirectionChange(e.target.value as typeof direction)}
          className="w-full px-2 py-1.5 text-sm border rounded-md bg-card focus:outline-none focus:ring-2 focus:ring-blue-500"
        >
          <option value="upstream">Upstream (Parents)</option>
          <option value="downstream">Downstream (Children)</option>
          <option value="both">Both Directions</option>
        </select>
      </div>

      {/* Layout toggle */}
      <div className="space-y-2">
        <div className="text-xs font-semibold text-gray-400 uppercase">Layout</div>
        <Button onClick={onToggleLayout} size="sm" variant="outline" className="w-full justify-start gap-2">
          {layout === 'TB' ? (
            <>
              <ArrowLeftRight className="w-4 h-4" />
              Switch to Horizontal
            </>
          ) : (
            <>
              <ArrowUpDown className="w-4 h-4" />
              Switch to Vertical
            </>
          )}
        </Button>
      </div>
    </div>
  )
}
