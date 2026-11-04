import { useEffect, useState } from 'react'
import { ArrowRight, ListChecks, MessageCircleQuestion, Plus, Sparkles, Trash2, X } from 'lucide-react'
import { completeness, kindLabels } from '../shared/plan'
import { nodeKinds, type Blueprint, type MindNode } from '../shared/types'
import { statusLabels } from './MindMap'

interface Props {
  node: MindNode
  blueprint: Blueprint
  locked: boolean
  busy: boolean
  onChange: (patch: Partial<MindNode>) => void
  onInterview: () => void
  onDraftCriteria: () => void
  onSuggest: () => void
  onDelete: () => void
  onAddChild: () => void
}

const kindHelp: Record<MindNode['kind'], string> = {
  app: 'The whole application. Its answers set the stack, audience and scope for every agent.',
  feature: 'A capability users rely on. Built by its own sub-agent.',
  screen: 'A view or page. Built by its own sub-agent after the data it needs.',
  data: 'Records the app stores. Built first so features share one model.',
  integration: 'An external service or API. Built by its own sub-agent.',
  rule: 'A business rule. Given to its parent agent as context rather than built alone.',
  constraint: 'A limit such as platform, privacy or performance. Given to agents as context.'
}

export function Inspector({ node, blueprint, locked, busy, onChange, onInterview, onDraftCriteria, onSuggest, onDelete, onAddChild }: Props) {
  const score = completeness(node)
  const [title, setTitle] = useState(node.title)
  useEffect(() => setTitle(node.title), [node.title])
  const isRoot = node.parentId === null
  const updateQuestion = (id: string, answer: string) => onChange({ questions: node.questions.map(item => item.id === id ? { ...item, answer } : item) })

  return <div className="inspector">
    <span className="section-kicker">02 / DETAIL NODE</span>
    <input className="title-input" aria-label="Node title" value={title} maxLength={120} disabled={locked}
      onChange={event => setTitle(event.target.value)} onBlur={() => title.trim() && title !== node.title ? onChange({ title: title.trim() }) : setTitle(node.title)}
      onKeyDown={event => { if (event.key === 'Enter') event.currentTarget.blur() }} />
    <div className="inspector-meta"><span className={`status-pill ${node.status}`}>{statusLabels[node.status]}</span><span>{score.percent}% detailed</span></div>
    <div className="progress-track"><span style={{ width: `${score.percent}%` }} /></div>

    {!isRoot && <>
      <label className="field-label" htmlFor="kind">Kind<span>{kindHelp[node.kind].split('.')[0]}</span></label>
      <select id="kind" value={node.kind} disabled={locked} onChange={event => onChange({ kind: event.target.value as MindNode['kind'] })}>
        {nodeKinds.filter(kind => kind !== 'app').map(kind => <option key={kind} value={kind}>{kindLabels[kind]}</option>)}
      </select>
    </>}
    <label className="field-label" htmlFor="summary">{isRoot ? 'The idea' : 'What is it?'}<span>{node.summary.length}/2000</span></label>
    <div className="prompt-field compact"><textarea id="summary" value={node.summary} maxLength={2000} disabled={locked} placeholder="Describe this part of the app in a sentence or two." onChange={event => onChange({ summary: event.target.value })} /></div>

    <div className="output-section">
      <div className="section-heading"><h3><MessageCircleQuestion size={15} />AI interview</h3><small>{score.answered}/{score.asked}</small></div>
      {!node.questions.length && <p className="panel-description">AI reads the whole map and asks what it needs to know to build <b>{node.title}</b>.</p>}
      <div className="questions">
        {node.questions.map((item, index) => <div key={item.id} className={`question ${item.answer.trim() ? 'answered' : ''}`}>
          <div className="question-text"><span>{String(index + 1).padStart(2, '0')}</span><p>{item.question}</p>
            {!locked && <button className="icon-button" title="Remove question" aria-label="Remove question" onClick={() => onChange({ questions: node.questions.filter(other => other.id !== item.id) })}><X size={12} /></button>}</div>
          {item.why && <small>{item.why}</small>}
          <textarea aria-label={`Answer: ${item.question}`} value={item.answer} rows={2} maxLength={4000} disabled={locked} placeholder="Your answer…" onChange={event => updateQuestion(item.id, event.target.value)} />
        </div>)}
      </div>
      <button className={node.questions.length ? 'secondary full' : 'primary full'} disabled={locked || busy} onClick={onInterview}>
        <Sparkles size={14} />{node.questions.length ? 'Ask follow-up questions' : 'Ask AI questions'}{!node.questions.length && <ArrowRight size={14} />}
      </button>
    </div>

    {!isRoot && <div className="output-section">
      <div className="section-heading"><h3><ListChecks size={15} />Acceptance criteria</h3><small>{score.criteria}</small></div>
      <p className="fine-print">How the agent proves this node is done. A node is only marked built when its agent finishes.</p>
      <div className="criteria">
        {node.acceptance.map((item, index) => <div key={index} className="criterion">
          <input aria-label={`Criterion ${index + 1}`} value={item} maxLength={400} disabled={locked} onChange={event => onChange({ acceptance: node.acceptance.map((other, i) => i === index ? event.target.value : other) })} />
          {!locked && <button className="icon-button" aria-label="Remove criterion" onClick={() => onChange({ acceptance: node.acceptance.filter((_, i) => i !== index) })}><X size={12} /></button>}
        </div>)}
      </div>
      <div className="two-buttons">
        <button className="secondary" disabled={locked} onClick={() => onChange({ acceptance: [...node.acceptance, ''] })}><Plus size={13} />Add</button>
        <button className="secondary" disabled={locked || busy || !score.answered} title={score.answered ? '' : 'Answer at least one question first'} onClick={onDraftCriteria}><Sparkles size={13} />Draft with AI</button>
      </div>
    </div>}

    <div className="output-section">
      <h3>Branches</h3>
      <p className="fine-print">{kindHelp[node.kind]}</p>
      <div className="two-buttons">
        <button className="secondary" disabled={locked} onClick={onAddChild}><Plus size={13} />Add child</button>
        <button className="secondary" disabled={locked || busy} onClick={onSuggest}><Sparkles size={13} />Suggest</button>
      </div>
      {!isRoot && <button className="text-button full danger" disabled={locked} onClick={() => { const count = blueprint.nodes.filter(item => item.parentId === node.id).length; if (!count || confirm(`Delete "${node.title}" and everything under it?`)) onDelete() }}><Trash2 size={13} />Delete node</button>}
    </div>
  </div>
}
