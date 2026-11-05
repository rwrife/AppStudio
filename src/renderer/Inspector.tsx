import { useEffect, useRef, useState } from 'react'
import { ArrowRight, ListChecks, MessageCircleQuestion, Pencil, Plus, Sparkles, Trash2, X } from 'lucide-react'
import { completeness, descendantIds, hasCurrentAnalysis, isBuildable, kindLabels } from '../shared/plan'
import { canDefineResource, executionTaskId, nodeKinds, resourceOwner, type Blueprint, type MindNode, type NodeConnection } from '../shared/types'
import { statusLabels } from './MindMap'

interface Props {
  node: MindNode
  blueprint: Blueprint
  locked: boolean
  busy: boolean
  onChange: (patch: Partial<MindNode>) => void
  onAnalyze: () => void
  onAnswer: (questionId: string) => void
  onConnect: (link: Omit<NodeConnection, 'id'>) => void
  onDisconnect: (id: string) => void
  onInterview: () => void
  onDraftCriteria: () => void
  onSuggest: () => void
  onDelete: () => void
  onAddChild: () => void
}

const kindHelp: Record<MindNode['kind'], string> = {
  app: 'The whole application. Its answers set the stack, audience and scope for every agent.',
  unspecified: 'AI chooses a type when you save and analyze this node.',
  feature: 'A capability users rely on. Built by its own sub-agent.',
  screen: 'A view or page. Built by its own sub-agent after the data it needs.',
  data: 'Records the app stores. Built first so features share one model.',
  integration: 'An external service or API. Built by its own sub-agent.',
  resource: 'A shared table, file, API, compute resource or output contract. Defines assigns its creator; References makes consumers wait for that creator. No separate resource agent.',
  ux: 'UX and visual design guidance. Written to AGENTS.md for current and future tasks, not built by a coding agent.',
  architecture: 'Technical tooling and architectural decisions. Written to AGENTS.md, not built by a coding agent.',
  rule: 'A business rule. Written to AGENTS.md as instructions, not built by a coding agent.',
  constraint: 'A limit such as platform, privacy or performance. Written to AGENTS.md as instructions.'
}

export function Inspector({ node, blueprint, locked, busy, onChange, onAnalyze, onAnswer, onConnect, onDisconnect, onInterview, onDraftCriteria, onSuggest, onDelete, onAddChild }: Props) {
  const score = completeness(node)
  const [title, setTitle] = useState(node.title)
  const [editingTitle, setEditingTitle] = useState(false)
  const editingTitleRef = useRef(false)
  const titleInput = useRef<HTMLInputElement>(null)
  useEffect(() => setTitle(node.title), [node.title])
  useEffect(() => { if (editingTitle) { titleInput.current?.focus(); titleInput.current?.select() } }, [editingTitle])
  const finishRename = (cancel = false) => {
    if (!editingTitleRef.current) return
    editingTitleRef.current = false
    setEditingTitle(false)
    if (!cancel && title.trim() && title.trim() !== node.title) onChange({ title: title.trim(), titleSource: 'manual' })
    else setTitle(node.title)
  }
  const isRoot = node.parentId === null
  const analyzed = hasCurrentAnalysis(node)
  const owner = node.kind === 'resource' ? resourceOwner(blueprint, node.id) : undefined
  const updateQuestion = (id: string, answer: string) => onChange({ questions: node.questions.map(item => item.id === id ? { ...item, answer } : item) })

  return <div className="inspector">
    <span className="section-kicker">02 / DETAIL NODE</span>
    <div className="node-title-editor"><input ref={titleInput} className="title-input" aria-label="Node title" value={title} maxLength={120} disabled={locked} readOnly={!editingTitle}
      onChange={event => setTitle(event.target.value)} onBlur={() => finishRename()}
      onKeyDown={event => {
        if (event.key === 'Escape') { finishRename(true); event.currentTarget.blur() }
        else if (event.key === 'Enter') event.currentTarget.blur()
      }} />
      <button className="icon-button" disabled={locked} aria-label="Rename node" title="Rename node: Enter saves, Escape cancels" onClick={() => { editingTitleRef.current = true; setEditingTitle(true) }}><Pencil size={14} /></button></div>
    <div className="inspector-meta"><span className={`status-pill ${node.status}`}>{statusLabels[node.status]}</span><span>{score.percent}% detailed</span></div>
    <div className="progress-track"><span style={{ width: `${score.percent}%` }} /></div>

    {!isRoot && <>
      <label className="field-label" htmlFor="kind">Node type<span>{isBuildable(node) ? 'Code output' : node.kind === 'resource' ? 'Shared contract' : 'AGENTS.md instructions'}</span></label>
      <select id="kind" value={node.kind} disabled={locked} onChange={event => onChange({ kind: event.target.value as MindNode['kind'] })}>
        {nodeKinds.filter(kind => kind !== 'app').map(kind => <option key={kind} value={kind}>{kindLabels[kind]}</option>)}
      </select>
    </>}
    {node.kind === 'resource' && <>
      <label className="field-label" htmlFor="resource-mode">Resource provision</label>
      <select id="resource-mode" value={node.resourceMode ?? 'managed'} disabled={locked}
        onChange={event => onChange({ resourceMode: event.target.value as MindNode['resourceMode'] })}>
        <option value="managed">Created by a build task</option>
        <option value="external">Externally provided</option>
      </select>
      <p className="fine-print">{node.resourceMode === 'external'
        ? 'Already provided outside this build. Agents use its contract without creating it; availability is not verified by App Studio.'
        : owner ? `Defined by ${owner.title}${executionTaskId(owner) === 'foundation' ? ' (foundation task)' : ''}. Consumers wait for this task to succeed. Remove Defines before switching to external.`
          : 'Needs a Defines owner before building. Add Defined by below to choose a code-output node or App/Architecture (foundation).'}
      </p>
    </>}
    <label className="field-label" htmlFor="summary">{isRoot ? 'The idea' : 'What is it?'}<span>{node.summary.length}/2000</span></label>
    <div className="prompt-field node-summary"><textarea id="summary" rows={7} value={node.summary} maxLength={2000} disabled={locked} placeholder="Describe this part of the app, including its behavior and important details." onChange={event => onChange({ summary: event.target.value })} /></div>
    <button className="primary full" disabled={locked || busy || !title.trim() || (!node.summary.trim() && title === 'New node')} onClick={onAnalyze}><Sparkles size={14} />Save &amp; analyze</button>
    <p className="fine-print">Edits are saved automatically. Analyze names the node, chooses an unselected type and asks only for missing details using your selected model. Rename it above any time; your chosen name is kept.</p>
    {analyzed && <p className="analysis-notice">{node.analysis?.message}</p>}

    <div className="output-section">
      <div className="section-heading"><h3><MessageCircleQuestion size={15} />AI interview</h3><small>{score.answered}/{score.asked}</small></div>
      {!node.questions.length && <p className="panel-description">{analyzed && node.analysis?.noFollowUps
        ? 'AI found no follow-up questions needed for the current details.'
        : <>AI reads the whole map and asks what it needs to know about <b>{node.title}</b>.</>}</p>}
      {!!node.questions.length && <p className="fine-print">Press Answer to review your response. AI may add follow-up questions and child nodes for concrete requirements you describe. Typing alone does not expand the map.</p>}
      <div className="questions">
        {node.questions.map((item, index) => <div key={item.id} className={`question ${item.answer.trim() ? 'answered' : ''}`}>
          <div className="question-text"><span>{String(index + 1).padStart(2, '0')}</span><p>{item.question}</p>
            {!locked && <button className="icon-button" title="Remove question" aria-label="Remove question" onClick={() => onChange({ questions: node.questions.filter(other => other.id !== item.id) })}><X size={12} /></button>}</div>
          {item.why && <small>{item.why}</small>}
          <textarea aria-label={`Answer: ${item.question}`} value={item.answer} rows={2} maxLength={4000} disabled={locked} placeholder="Your answer…" onChange={event => updateQuestion(item.id, event.target.value)} />
          <button className="secondary full" disabled={locked || busy || !item.answer.trim() || item.answer === item.reviewedAnswer} onClick={() => onAnswer(item.id)}>
            <ArrowRight size={13} />{item.answer === item.reviewedAnswer ? 'Answer reviewed' : 'Answer'}
          </button>
        </div>)}
      </div>
      <button className="secondary full" disabled={locked || busy} onClick={onInterview}>
        <Sparkles size={14} />{node.questions.length ? 'Ask follow-up questions' : 'Ask AI questions'}{!node.questions.length && <ArrowRight size={14} />}
      </button>
    </div>

    {!isRoot && <div className="output-section">
      <div className="section-heading"><h3><ListChecks size={15} />Acceptance criteria</h3><small>{score.criteria}</small></div>
      <p className="fine-print">{isBuildable(node) ? 'How the agent proves this node is done. A node is only marked built when its agent finishes.' : node.kind === 'resource'
        ? 'The shared schema, location, lifecycle and access rules its owner and consumers must follow. This contract does not run its own agent.'
        : 'Checks that future tasks should meet when following these instructions. This node does not produce code.'}</p>
      <div className="criteria">
        {node.acceptance.map((item, index) => <div key={index} className="criterion">
          <input aria-label={`Criterion ${index + 1}`} value={item} maxLength={400} disabled={locked} onChange={event => onChange({ acceptance: node.acceptance.map((other, i) => i === index ? event.target.value : other) })} />
          {!locked && <button className="icon-button" aria-label="Remove criterion" onClick={() => onChange({ acceptance: node.acceptance.filter((_, i) => i !== index) })}><X size={12} /></button>}
        </div>)}
      </div>
      <div className="two-buttons">
        <button className="secondary" disabled={locked} onClick={() => onChange({ acceptance: [...node.acceptance, ''] })}><Plus size={13} />Add</button>
        <button className="secondary" disabled={locked || busy || (!score.answered && !analyzed)} title={score.answered || analyzed ? '' : 'Answer a question or analyze the details first'} onClick={onDraftCriteria}><Sparkles size={13} />Draft with AI</button>
      </div>
    </div>}

    <Connections node={node} blueprint={blueprint} locked={locked} onChange={onChange} onConnect={onConnect} onDisconnect={onDisconnect} />

    <div className="output-section">
      <h3>Branches</h3>
      <p className="fine-print">{kindHelp[node.kind]}</p>
      <div className="two-buttons">
        <button className="secondary" disabled={blueprint.nodes.length >= 400} onClick={onAddChild}><Plus size={13} />Add child</button>
        <button className="secondary" disabled={locked || busy} onClick={onSuggest}><Sparkles size={13} />Suggest</button>
      </div>
      {!isRoot && <button className="text-button full danger" disabled={locked} onClick={() => { const count = blueprint.nodes.filter(item => item.parentId === node.id).length; if (!count || confirm(`Delete "${node.title}" and everything under it?`)) onDelete() }}><Trash2 size={13} />Delete node</button>}
    </div>
  </div>
}

function Connections({ node, blueprint, locked, onChange, onConnect, onDisconnect }: Pick<Props, 'node' | 'blueprint' | 'locked' | 'onChange' | 'onConnect' | 'onDisconnect'>) {
  const [kind, setKind] = useState<NodeConnection['kind']>('similar')
  const [targetId, setTargetId] = useState('')
  const descendants = descendantIds(blueprint, node.id)
  const links = blueprint.connections.filter(link => link.sourceId === node.id || link.targetId === node.id)
  const isResource = node.kind === 'resource'
  const allowed: NodeConnection['kind'][] = ['similar', ...(isBuildable(node) ? ['dependency' as const] : []),
    ...(canDefineResource(node) || (isResource && node.resourceMode !== 'external') ? ['defines' as const] : []), 'references']
  const effectiveKind = allowed.includes(kind) ? kind : 'similar'
  const candidates = blueprint.nodes.filter(item => {
    if (item.id === node.id) return false
    if (effectiveKind === 'similar') return true
    if (effectiveKind === 'dependency') return isBuildable(item)
    if (isResource) return effectiveKind === 'defines' ? canDefineResource(item) : item.kind !== 'resource'
    return item.kind === 'resource' && (effectiveKind !== 'defines' || item.resourceMode !== 'external')
  })
  const target = candidates.find(item => item.id === targetId)
  const name = (id: string) => blueprint.nodes.find(item => item.id === id)?.title ?? id

  return <div className="output-section">
    <h3>Connections</h3>
    {node.parentId && <>
      <label className="field-label" htmlFor="parent-node">Child of<span>Feature hierarchy</span></label>
      <select id="parent-node" value={node.parentId} disabled={locked} onChange={event => onChange({ parentId: event.target.value })}>
        {blueprint.nodes.filter(item => item.id !== node.id && !descendants.has(item.id)).map(item => <option key={item.id} value={item.id}>{item.title}</option>)}
      </select>
    </>}
    <p className="fine-print">Dependencies build inputs first. Defines assigns a resource's single creator; References waits for that creator without recreating the resource. App/Architecture owners and instruction-only references use foundation. Similarity shares patterns only.</p>
    <ul className="connection-list">
      {links.map(link => <li key={link.id}>
        <span>{link.kind === 'similar' ? `Similar to ${name(link.sourceId === node.id ? link.targetId : link.sourceId)}`
          : link.kind === 'defines' ? link.targetId === node.id ? `Defined by ${name(link.sourceId)}` : `Defines ${name(link.targetId)}`
          : link.kind === 'references' ? link.targetId === node.id ? `Referenced by ${name(link.sourceId)}` : `References ${name(link.targetId)}`
          : link.targetId === node.id ? `Input from ${name(link.sourceId)}` : `Output to ${name(link.targetId)}`}</span>
        <button className="icon-button" disabled={locked} aria-label={`Remove connection to ${name(link.sourceId === node.id ? link.targetId : link.sourceId)}`} onClick={() => onDisconnect(link.id)}><X size={12} /></button>
      </li>)}
    </ul>
    <label className="field-label" htmlFor="connection-kind">Relationship</label>
    <select id="connection-kind" value={effectiveKind} disabled={locked} onChange={event => setKind(event.target.value as NodeConnection['kind'])}>
      <option value="similar">Similar to</option>
      {isBuildable(node) && <option value="dependency">Depends on (input from)</option>}
      {allowed.includes('defines') && <option value="defines">{isResource ? 'Defined by' : 'Defines'}</option>}
      <option value="references">{isResource ? 'Referenced by' : 'References'}</option>
    </select>
    <label className="field-label" htmlFor="connection-node">Connected node</label>
    <select id="connection-node" value={target?.id ?? ''} disabled={locked} onChange={event => setTargetId(event.target.value)}>
      <option value="">Choose a node</option>
      {candidates.map(item => <option key={item.id} value={item.id}>{item.title}</option>)}
    </select>
    <button className="secondary full" disabled={locked || !target} onClick={() => {
      const reverse = effectiveKind === 'dependency' || (isResource && (effectiveKind === 'defines' || effectiveKind === 'references'))
      if (target) onConnect({ kind: effectiveKind, sourceId: reverse ? target.id : node.id, targetId: reverse ? node.id : target.id })
    }}><Plus size={13} />Add connection</button>
  </div>
}
