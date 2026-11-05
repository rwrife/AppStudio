import { childrenOf, rootOf } from './plan'
import type { Blueprint } from './types'

export const columnWidth = 300
export const rowHeight = 150
export const horizontalGap = 50
export const verticalGap = 24
export interface NodeSize { width: number; height: number }

/** Reserve each subtree's full height, including internal cards, before stacking siblings. */
export function tidyLayout(blueprint: Blueprint, sizes: ReadonlyMap<string, NodeSize> = new Map()): Blueprint {
  // Unmounted cards use conservative bounds for the schema's 120-character titles.
  const sizeOf = (node: Blueprint['nodes'][number]): NodeSize =>
    sizes.get(node.id) ?? { width: node.kind === 'app' ? 250 : 230, height: 260 }
  const widths: number[] = []
  const place = (node: Blueprint['nodes'][number], depth: number): { height: number; center: number; positions: Map<string, { depth: number; y: number }> } => {
    const size = sizeOf(node)
    widths[depth] = Math.max(widths[depth] ?? 0, size.width)
    const positions = new Map<string, { depth: number; y: number }>()
    const centers: number[] = []
    let bottom = 0
    for (const child of childrenOf(blueprint, node.id)) {
      const subtree = place(child, depth + 1)
      centers.push(bottom + subtree.center)
      for (const [id, position] of subtree.positions) positions.set(id, { ...position, y: position.y + bottom })
      bottom += subtree.height + verticalGap
    }
    const center = centers.length ? (centers[0] + centers[centers.length - 1]) / 2 : size.height / 2
    const top = Math.min(0, center - size.height / 2)
    const height = Math.max(centers.length ? bottom - verticalGap : 0, center + size.height / 2) - top
    for (const position of positions.values()) position.y -= top
    positions.set(node.id, { depth, y: center - size.height / 2 - top })
    return { height, center: center - top, positions }
  }
  const { positions } = place(rootOf(blueprint), 0)
  const columns: number[] = [0]
  for (let depth = 1; depth < widths.length; depth++) columns[depth] = columns[depth - 1] + widths[depth - 1] + horizontalGap
  return { ...blueprint, nodes: blueprint.nodes.map(node => {
    const position = positions.get(node.id)
    return { ...node, position: position ? { x: columns[position.depth], y: position.y } : node.position }
  }) }
}

export function childPosition(blueprint: Blueprint, parentId: string) {
  const parent = blueprint.nodes.find(node => node.id === parentId)
  if (!parent) return { x: 0, y: 0 }
  const siblings = childrenOf(blueprint, parentId)
  const x = parent.position.x + columnWidth
  if (!siblings.length) return { x, y: parent.position.y }
  return { x, y: Math.max(...siblings.map(item => item.position.y)) + rowHeight }
}
