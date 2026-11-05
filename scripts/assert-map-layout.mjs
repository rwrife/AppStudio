import assert from 'node:assert/strict'
import { expect } from '@playwright/test'

export async function assertMapLayout(page, blueprint) {
  const geometry = () => page.locator('.react-flow__node').evaluateAll(elements => elements.map(element => {
    const position = new DOMMatrixReadOnly(getComputedStyle(element).transform)
    const card = element.querySelector('.mind-card')
    return { id: element.dataset.id, x: position.e, y: position.f, width: card.offsetWidth, height: card.offsetHeight }
  }))
  const expected = blueprint.nodes.map(node => ({ id: node.id, ...node.position })).sort((a, b) => a.id.localeCompare(b.id))
  await expect.poll(async () => (await geometry()).map(({ id, x, y }) => ({ id, x, y })).sort((a, b) => a.id.localeCompare(b.id))).toEqual(expected)
  const cards = await geometry()
  for (let i = 0; i < cards.length; i++) for (const b of cards.slice(i + 1)) {
    const a = cards[i]
    assert.ok(b.x - a.x - a.width >= 49 || a.x - b.x - b.width >= 49 ||
      b.y - a.y - a.height >= 23 || a.y - b.y - b.height >= 23,
    `${a.id} and ${b.id} must have at least 50px horizontal or 24px vertical spacing (1px rounding tolerance)`)
  }
}
