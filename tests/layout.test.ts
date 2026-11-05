import { test } from 'node:test'
import assert from 'node:assert/strict'
import { horizontalGap, tidyLayout, verticalGap, type NodeSize } from '../src/shared/layout'
import type { Blueprint, MindNode } from '../src/shared/types'

const node = (id: string, parentId: string | null, kind: MindNode['kind'] = 'feature'): MindNode =>
  ({ id, parentId, kind, title: id, summary: '', questions: [], acceptance: [], status: 'draft', position: { x: 17, y: 29 } })
const blueprint = (nodes: MindNode[]): Blueprint =>
  ({ id: 'bp', name: 'Test', createdAt: '', updatedAt: '', outputDir: '', nodes, connections: [] })

function assertSeparated(bp: Blueprint, sizes: ReadonlyMap<string, NodeSize>) {
  for (let i = 0; i < bp.nodes.length; i++) for (const b of bp.nodes.slice(i + 1)) {
    const a = bp.nodes[i]
    const first = sizes.get(a.id)!
    const second = sizes.get(b.id)!
    assert.ok(
      b.position.x - a.position.x - first.width >= horizontalGap ||
      a.position.x - b.position.x - second.width >= horizontalGap ||
      b.position.y - a.position.y - first.height >= verticalGap ||
      a.position.y - b.position.y - second.height >= verticalGap,
      `${a.id} and ${b.id} must have a visible gap`
    )
  }
}

test('tidy separates mixed instruction cards and centres parents by card centres', () => {
  const bp = blueprint([node('root', null, 'app'), node('architecture', 'root', 'architecture'), node('ux', 'root', 'ux'), node('rule', 'root', 'rule'), node('feature', 'root')])
  const sizes = new Map<string, NodeSize>([
    ['root', { width: 250, height: 135 }], ['architecture', { width: 230, height: 190 }],
    ['ux', { width: 230, height: 215 }], ['rule', { width: 230, height: 155 }], ['feature', { width: 230, height: 120 }]
  ])
  const laid = tidyLayout(bp, sizes)
  assertSeparated(laid, sizes)
  const [root, first, , , last] = laid.nodes
  assert.equal(root.position.y + sizes.get(root.id)!.height / 2,
    (first.position.y + sizes.get(first.id)!.height / 2 + last.position.y + sizes.get(last.id)!.height / 2) / 2)
  assert.deepEqual(tidyLayout(laid, sizes), laid, 'Tidy is idempotent')
  assert.deepEqual(bp.nodes[0].position, { x: 17, y: 29 }, 'input is not mutated')
})

test('tidy reserves tall internal nodes, not only leaf rows, and uses each column width', () => {
  const bp = blueprint([node('root', null, 'app'), node('a', 'root'), node('aa', 'a'), node('b', 'root'), node('bb', 'b'), node('c', 'root'), node('cc', 'c')])
  const sizes = new Map(bp.nodes.map((item, i) => [item.id, { width: i === 1 ? 420 : 250, height: i === 1 || i === 3 ? 500 : 100 }]))
  const laid = tidyLayout(bp, sizes)
  assertSeparated(laid, sizes)
  assert.equal(laid.nodes[2].position.x - laid.nodes[1].position.x, 420 + horizontalGap)
})

test('tidy fallback separates unmounted cards and preserves blueprint content and connections', () => {
  const bp = blueprint([node('root', null, 'app'), node('a', 'root', 'architecture'), node('b', 'root', 'ux')])
  bp.connections = [{ id: 'like', kind: 'similar', sourceId: 'a', targetId: 'b' }]
  const laid = tidyLayout(bp)
  assertSeparated(laid, new Map(bp.nodes.map(item => [item.id, { width: item.kind === 'app' ? 250 : 230, height: 260 }])))
  assert.deepEqual(laid.connections, bp.connections)
  assert.deepEqual(laid.nodes.map(({ position, ...rest }) => rest), bp.nodes.map(({ position, ...rest }) => rest))
})
