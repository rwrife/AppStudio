import { childrenOf, rootOf } from './plan'
import type { Blueprint } from './types'

export const columnWidth = 300
export const rowHeight = 150

/** Left-to-right tidy tree: depth sets the column, leaves are stacked and parents centred on their children. */
export function tidyLayout(blueprint: Blueprint): Blueprint {
  const positions = new Map<string, { x: number; y: number }>()
  let row = 0
  const place = (id: string, depth: number, seen: Set<string>): number => {
    if (seen.has(id)) return row * rowHeight
    seen.add(id)
    const children = childrenOf(blueprint, id)
    let y: number
    if (!children.length) y = row++ * rowHeight
    else {
      const ys = children.map(child => place(child.id, depth + 1, seen))
      y = (Math.min(...ys) + Math.max(...ys)) / 2
    }
    positions.set(id, { x: depth * columnWidth, y })
    return y
  }
  place(rootOf(blueprint).id, 0, new Set())
  return { ...blueprint, nodes: blueprint.nodes.map(node => ({ ...node, position: positions.get(node.id) ?? node.position })) }
}

export function childPosition(blueprint: Blueprint, parentId: string) {
  const parent = blueprint.nodes.find(node => node.id === parentId)
  if (!parent) return { x: 0, y: 0 }
  const siblings = childrenOf(blueprint, parentId)
  const x = parent.position.x + columnWidth
  if (!siblings.length) return { x, y: parent.position.y }
  return { x, y: Math.max(...siblings.map(item => item.position.y)) + rowHeight }
}
