'use client'

import { memo } from 'react'
import { EdgeProps, getSmoothStepPath, EdgeLabelRenderer } from 'reactflow'

export const JobEdge = memo((props: EdgeProps) => {
  const {
    id,
    sourceX,
    sourceY,
    targetX,
    targetY,
    sourcePosition,
    targetPosition,
    data,
  } = props

  const [edgePath, labelX, labelY] = getSmoothStepPath({
    sourceX,
    sourceY,
    sourcePosition,
    targetX,
    targetY,
    targetPosition,
  })

  // Style edges based on type
  const edgeStyles = {
    execution_of: { stroke: '#3b82f6', strokeWidth: 2, dashArray: '0' },
    created_job: { stroke: '#10b981', strokeWidth: 2, dashArray: '5,5' },
    spawned_job: { stroke: '#8b5cf6', strokeWidth: 2, dashArray: '0' },
    child_execution: { stroke: '#f59e0b', strokeWidth: 2, dashArray: '5,5' },
    dispatched_request: { stroke: '#ec4899', strokeWidth: 2, dashArray: '3,3' },
  }

  const style = edgeStyles[data?.type as keyof typeof edgeStyles] || edgeStyles.execution_of

  return (
    <>
      <path
        id={id}
        className="react-flow__edge-path"
        d={edgePath}
        stroke={style.stroke}
        strokeWidth={style.strokeWidth}
        strokeDasharray={style.dashArray}
        fill="none"
        markerEnd="url(#arrowhead)"
      />
      {data?.label && (
        <EdgeLabelRenderer>
          <div
            style={{
              position: 'absolute',
              transform: `translate(-50%, -50%) translate(${labelX}px,${labelY}px)`,
              pointerEvents: 'all',
            }}
            className="nodrag nopan bg-white px-2 py-1 rounded text-xs border shadow-sm"
          >
            {data.label}
          </div>
        </EdgeLabelRenderer>
      )}
    </>
  )
})
JobEdge.displayName = 'JobEdge'
