import { Node, Edge, Position } from 'reactflow'
import { GraphNode, GraphEdge } from './graph-queries'

export interface LayoutOptions {
  direction: 'TB' | 'LR' // Top-to-Bottom or Left-to-Right
  nodeWidth: number
  nodeHeight: number
  horizontalSpacing: number
  verticalSpacing: number
}

/**
 * Layout graph nodes hierarchically based on their level
 * Positions nodes to minimize edge crossings and provide clear visual hierarchy
 */
export function layoutGraph(
  graphNodes: GraphNode[],
  graphEdges: GraphEdge[],
  options: LayoutOptions
): { nodes: Node[], edges: Edge[] } {
  // Group nodes by level
  const nodesByLevel = new Map<number, GraphNode[]>()
  for (const node of graphNodes) {
    const levelNodes = nodesByLevel.get(node.level) || []
    levelNodes.push(node)
    nodesByLevel.set(node.level, levelNodes)
  }

  const nodes: Node[] = []
  const maxLevel = Math.max(...graphNodes.map(n => n.level), 0)

  // Calculate positions for each level
  for (let level = 0; level <= maxLevel; level++) {
    const levelNodes = nodesByLevel.get(level) || []

    // Center nodes within their level
    const levelWidth = levelNodes.length * (options.nodeWidth + options.horizontalSpacing)
    const startOffset = -levelWidth / 2

    levelNodes.forEach((node, index) => {
      let x: number
      let y: number

      if (options.direction === 'TB') {
        // Top to Bottom: levels go down, nodes spread horizontally
        x = startOffset + index * (options.nodeWidth + options.horizontalSpacing) + options.nodeWidth / 2
        y = level * (options.nodeHeight + options.verticalSpacing)
      } else {
        // Left to Right: levels go right, nodes spread vertically
        x = level * (options.nodeWidth + options.horizontalSpacing)
        y = startOffset + index * (options.nodeHeight + options.verticalSpacing) + options.nodeHeight / 2
      }

      nodes.push({
        id: node.id,
        type: node.type,
        position: { x, y },
        data: node,
        sourcePosition: options.direction === 'TB' ? Position.Bottom : Position.Right,
        targetPosition: options.direction === 'TB' ? Position.Top : Position.Left,
      })
    })
  }

  // Convert edges to React Flow format
  const edges: Edge[] = graphEdges.map(e => ({
    id: e.id,
    source: e.source,
    target: e.target,
    type: 'jobEdge',
    data: { type: e.type, label: e.label },
    animated: e.type === 'execution_of', // Animate execution edges for emphasis
    style: { strokeWidth: 2 },
  }))

  return { nodes, edges }
}
