import { test } from 'node:test'
import assert from 'node:assert/strict'
import { agentPrompt, analysisPrompt, analysisResponse, answerPrompt, answerResponse, branchesResponse, extractJson, interviewPrompt, questionsResponse } from '../src/shared/prompts'
import { planBuild } from '../src/shared/plan'
import type { Blueprint } from '../src/shared/types'

const bp: Blueprint = {
  id: 'bp', name: 'Gym', createdAt: '', updatedAt: '', outputDir: '', connections: [],
  nodes: [
    { id: 'root', parentId: null, kind: 'app', title: 'Gym booking', summary: 'Book trainers', questions: [], acceptance: [], status: 'draft', position: { x: 0, y: 0 } },
    { id: 'book', parentId: 'root', kind: 'feature', title: 'Booking', summary: 'Clients book sessions', questions: [{ id: 'q', question: 'Cancellation window?', why: '', answer: '24 hours' }], acceptance: ['Client can cancel up to 24h before'], status: 'ready', position: { x: 0, y: 0 } },
    { id: 'rule', parentId: 'book', kind: 'rule', title: 'No double booking', summary: 'A trainer has one client per slot', questions: [], acceptance: [], status: 'draft', position: { x: 0, y: 0 } }
  ]
}

test('extractJson handles fences, prose and nested strings', () => {
  assert.deepEqual(extractJson('Sure!\n```json\n{"questions":[{"question":"Who {uses} it?"}]}\n```'), { questions: [{ question: 'Who {uses} it?' }] })
  assert.deepEqual(extractJson('Here you go: {"criteria":["a","b"]} hope that helps'), { criteria: ['a', 'b'] })
  assert.deepEqual(extractJson('noise [not json} {"ok":true}'), { ok: true })
  assert.throws(() => extractJson('no json here'), /did not return JSON/)
})

test('response schemas reject malformed model output', () => {
  assert.equal(questionsResponse.safeParse({ questions: [] }).success, false)
  assert.equal(branchesResponse.safeParse({ branches: [{ kind: 'app', title: 'x' }] }).success, false)
  assert.equal(branchesResponse.safeParse({ branches: [{ kind: 'screen', title: 'Calendar' }] }).success, true)
})

test('interview prompt carries focus, context and already-answered questions', () => {
  const prompt = interviewPrompt(bp, bp.nodes[1])
  assert.match(prompt, /Focus node: \[Feature\] Booking/)
  assert.match(prompt, /Cancellation window\?: 24 hours/)
  assert.match(prompt, /Schema: \{"questions"/)
})

test('agent prompt includes decisions, child rules and acceptance criteria', () => {
  const task = planBuild(bp).find(item => item.id === 'agent-book')!
  const prompt = agentPrompt(bp, task)
  assert.match(prompt, /implementing exactly one node/)
  assert.match(prompt, /Cancellation window\? → 24 hours/)
  assert.match(prompt, /No double booking: A trainer has one client per slot/)
  assert.match(prompt, /Client can cancel up to 24h before/)
  assert.match(agentPrompt(bp, planBuild(bp)[0]), /APP_STUDIO\.md/)
  assert.match(prompt, /Read AGENTS\.md/)
})

test('initial questions adapt scope, audience, platform, usage and look and feel to the idea', () => {
  for (const prompt of [analysisPrompt(bp, bp.nodes[0]), interviewPrompt(bp, bp.nodes[0])]) {
    assert.match(prompt, /target audience/)
    assert.match(prompt, /runtime platforms/)
    assert.match(prompt, /usage workflow/)
    assert.match(prompt, /look and feel/)
    assert.match(prompt, /basic vs scientific/)
    assert.match(prompt, /Tailor every question to this particular idea/)
  }
})

test('analysis preserves chosen types/names and permits no follow-up questions', () => {
  const prompt = analysisPrompt(bp, bp.nodes[1])
  assert.match(prompt, /selected kind "feature". Preserve it exactly/)
  assert.match(prompt, /chose the title "Booking". Preserve it exactly/)
  assert.match(prompt, /Do not use tools/)
  const auto = analysisPrompt(bp, { ...bp.nodes[1], kind: 'unspecified', titleSource: 'auto' })
  assert.match(auto, /Choose the best kind/)
  assert.match(auto, /Create a concise, descriptive node title/)
  assert.equal(analysisResponse.safeParse({ kind: 'ux', title: 'Calm visual style', message: 'Sufficient detail.', questions: [] }).success, true)
  assert.equal(analysisResponse.safeParse({ kind: 'unspecified', title: 'x', message: 'x', questions: [] }).success, false)
  assert.equal(analysisResponse.safeParse({ kind: 'feature', title: '   ', message: 'x', questions: [] }).success, false)
})

test('answer expansion uses previous decisions and only creates grounded, nonduplicate child nodes', () => {
  const prompt = answerPrompt(bp, bp.nodes[1], bp.nodes[1].questions[0])
  assert.match(prompt, /Submitted answer: 24 hours/)
  assert.match(prompt, /concrete, separate requirements explicitly supplied by this answer/)
  assert.match(prompt, /Do not duplicate existing nodes/)
  assert.match(prompt, /AGENTS\.md instructions/)
  assert.match(prompt, /Do not use tools/)
  assert.equal(answerResponse.safeParse({ questions: [], branches: [] }).success, true)
  assert.equal(answerResponse.safeParse({ questions: [], branches: [{ kind: 'architecture', title: 'Desktop runtime', summary: 'Electron on Windows' }] }).success, true)
  assert.equal(answerResponse.safeParse({ questions: [], branches: [{ kind: 'app', title: 'Duplicate root' }] }).success, false)
})
