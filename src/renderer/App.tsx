import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ArrowRight, Check, Cpu, FolderKanban, Hammer, LoaderCircle, MessageCircleQuestion, Network, Plus, ShieldCheck, Sparkles, Trash2, Workflow, X } from 'lucide-react'
import { MindMap } from './MindMap'
import { Inspector } from './Inspector'
import { BuildCenter, BuildPanel } from './BuildView'
import { SettingsModal } from './SettingsModal'
import { blueprintGaps, completeness, descendantIds } from '../shared/plan'
import { childPosition, tidyLayout } from '../shared/layout'
import type { Blueprint, BranchSuggestion, MindNode, NodeKind, ProviderInfo, Snapshot } from '../shared/types'

export const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error)).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
const newId = () => crypto.randomUUID().replace(/-/g, '').slice(0, 16)
const ideas = ['A booking app for personal trainers', 'A shared grocery list for families', 'An internal tool to track laptop loans']

export function statusFor(node: MindNode, previous?: MindNode): MindNode['status'] {
  if (['queued', 'building'].includes(node.status)) return node.status
  const content = (item: MindNode) => JSON.stringify([item.kind, item.title, item.summary, item.questions, item.acceptance])
  if (['built', 'failed'].includes(node.status) && previous && content(previous) === content(node)) return node.status
  return completeness(node).ready ? 'ready' : 'draft'
}

export function App() {
  const [snapshot, setSnapshot] = useState<Snapshot>()
  const [activeId, setActiveId] = useState<string>()
  const [draft, setDraft] = useState<Blueprint>()
  const [selectedId, setSelectedId] = useState<string>()
  const [tab, setTab] = useState<'map' | 'build'>('map')
  const [fitSignal, setFitSignal] = useState(0)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [providers, setProviders] = useState<ProviderInfo[]>([])
  const [error, setError] = useState<string>()
  const [busy, setBusy] = useState<string>()
  const [idea, setIdea] = useState('')
  const [creating, setCreating] = useState(false)
  const [suggestions, setSuggestions] = useState<{ parentId: string; items: BranchSuggestion[] }>()
  const dirty = useRef(false), version = useRef(0), saveTimer = useRef<ReturnType<typeof setTimeout>>(undefined)
  const activeRef = useRef<string>(undefined), draftRef = useRef<Blueprint>(undefined)
  activeRef.current = activeId
  draftRef.current = draft

  const apply = useCallback((next: Snapshot) => {
    setSnapshot(next)
    const id = activeRef.current && next.blueprints.some(item => item.id === activeRef.current) ? activeRef.current : next.blueprints[0]?.id
    if (id !== activeRef.current) { setActiveId(id); dirty.current = false }
    const building = next.run?.status === 'running' && next.run.blueprintId === id
    if (!dirty.current || building) setDraft(next.blueprints.find(item => item.id === id))
  }, [])

  useEffect(() => {
    window.studio.snapshot().then(apply).catch(reason => setError(errorText(reason)))
    window.studio.providers().then(setProviders).catch(() => undefined)
    return window.studio.onUpdate(apply)
  }, [apply])

  const run = snapshot?.run
  const locked = !!draft && run?.status === 'running' && run.blueprintId === draft.id
  const settings = snapshot?.settings
  const provider = providers.find(item => item.id === settings?.provider)
  const model = settings ? settings.selectedModel[settings.provider] : ''
  const selected = draft?.nodes.find(node => node.id === selectedId) ?? draft?.nodes.find(node => node.parentId === null)

  const commit = useCallback((change: (blueprint: Blueprint) => Blueprint) => {
    const current = draftRef.current
    if (!current) return
    const next = change(structuredClone(current))
    const before = new Map(current.nodes.map(node => [node.id, node]))
    next.nodes = next.nodes.map(node => ({ ...node, status: statusFor(node, before.get(node.id)) }))
    draftRef.current = next
    setDraft(next)
    dirty.current = true
    const stamp = ++version.current
    clearTimeout(saveTimer.current)
    saveTimer.current = setTimeout(() => {
      window.studio.saveBlueprint(next).then(() => { if (version.current === stamp) dirty.current = false }).catch(reason => setError(errorText(reason)))
    }, 350)
  }, [])

  const updateNode = useCallback((id: string, patch: Partial<MindNode>) => {
    commit(blueprint => ({ ...blueprint, name: blueprint.nodes.find(node => node.id === id)?.parentId === null && patch.title ? patch.title : blueprint.name, nodes: blueprint.nodes.map(node => node.id === id ? { ...node, ...patch } : node) }))
  }, [commit])

  const addChild = useCallback((parentId: string, kind: NodeKind = 'feature', title = 'New node', summary = '') => {
    const id = newId()
    commit(blueprint => ({ ...blueprint, nodes: [...blueprint.nodes, { id, parentId, kind, title, summary, questions: [], acceptance: [], status: 'draft', position: childPosition(blueprint, parentId) }] }))
    return id
  }, [commit])

  const deleteNode = useCallback((id: string) => {
    commit(blueprint => {
      const gone = descendantIds(blueprint, id)
      gone.add(id)
      return { ...blueprint, nodes: blueprint.nodes.filter(node => !gone.has(node.id) || node.parentId === null) }
    })
    setSelectedId(undefined)
  }, [commit])

  async function withBusy<T>(label: string, work: () => Promise<T>) {
    setBusy(label); setError(undefined)
    try { return await work() } catch (reason) { setError(errorText(reason)); return undefined } finally { setBusy(undefined) }
  }

  async function interview(node: MindNode) {
    if (!draftRef.current) return
    const result = await withBusy(`Asking ${provider?.label ?? 'AI'} about ${node.title}`, () => window.studio.interview(draftRef.current!, node.id))
    if (result) commit(blueprint => ({ ...blueprint, nodes: blueprint.nodes.map(item => item.id === node.id ? { ...item, questions: [...item.questions, ...result.questions] } : item) }))
  }

  async function suggest(node: MindNode) {
    if (!draftRef.current) return
    const items = await withBusy(`Suggesting branches for ${node.title}`, () => window.studio.suggestBranches(draftRef.current!, node.id))
    if (items) setSuggestions({ parentId: node.id, items })
  }

  async function draftCriteria(node: MindNode) {
    if (!draftRef.current) return
    const criteria = await withBusy(`Drafting acceptance criteria for ${node.title}`, () => window.studio.draftAcceptance(draftRef.current!, node.id))
    if (criteria) commit(blueprint => ({ ...blueprint, nodes: blueprint.nodes.map(item => item.id === node.id ? { ...item, acceptance: [...item.acceptance.filter(text => text.trim()), ...criteria] } : item) }))
  }

  function acceptSuggestions(picked: BranchSuggestion[]) {
    if (!suggestions) return
    for (const item of picked) addChild(suggestions.parentId, item.kind, item.title, item.summary)
    setSuggestions(undefined)
  }

  async function createBlueprint() {
    const blueprint = await withBusy('Creating blueprint', () => window.studio.createBlueprint(idea))
    if (!blueprint) return
    activeRef.current = blueprint.id
    dirty.current = false
    setActiveId(blueprint.id); setDraft(blueprint); setSelectedId(blueprint.nodes[0].id); setIdea(''); setCreating(false); setTab('map')
  }

  function openBlueprint(id: string) {
    clearTimeout(saveTimer.current)
    if (dirty.current && draftRef.current) void window.studio.saveBlueprint(draftRef.current).catch(reason => setError(errorText(reason)))
    dirty.current = false
    activeRef.current = id
    setActiveId(id); setDraft(snapshot?.blueprints.find(item => item.id === id)); setSelectedId(undefined); setSuggestions(undefined)
  }

  const stats = useMemo(() => {
    if (!draft) return { total: 0, ready: 0, gaps: [] as MindNode[], questions: 0, answered: 0 }
    const gaps = blueprintGaps(draft)
    const all = draft.nodes.map(completeness)
    return { total: draft.nodes.length, ready: draft.nodes.length - gaps.length, gaps, questions: all.reduce((sum, item) => sum + item.asked, 0), answered: all.reduce((sum, item) => sum + item.answered, 0) }
  }, [draft])

  const step = !draft ? 0 : draft.nodes.length < 3 ? 1 : stats.gaps.length ? 2 : run?.blueprintId === draft.id && run.status === 'done' ? 4 : 3
  const steps = [
    { title: 'Describe the idea', detail: 'One sentence is enough', icon: <Sparkles size={15} /> },
    { title: 'Map the details', detail: 'Branches for each part', icon: <Network size={15} /> },
    { title: 'Answer AI questions', detail: `${stats.answered}/${stats.questions} answered`, icon: <MessageCircleQuestion size={15} /> },
    { title: 'Build with agents', detail: 'One sub-agent per node', icon: <Hammer size={15} /> }
  ]

  return <div className="app">
    <header className="topbar">
      <div className="brand">
        <div className="brand-mark"><Workflow size={19} strokeWidth={2.2} /></div>
        <strong>app<span>studio</span></strong>
        <span className="version">POC 0.1</span>
      </div>
      <nav className="workspace-tabs" aria-label="Workspace">
        <button className={tab === 'map' ? 'active' : ''} onClick={() => setTab('map')}>Blueprint</button>
        <i />
        <button className={tab === 'build' ? 'active' : ''} onClick={() => setTab('build')}>Build</button>
      </nav>
      <button className={`connection ${provider && !provider.installed ? 'warning' : ''}`} onClick={() => setSettingsOpen(true)} title="Model settings">
        <span className="tiny-dot" />
        {provider ? `${provider.label}${model ? ` · ${model}` : ''}` : 'Choose a model'}
        <Cpu size={14} />
      </button>
    </header>

    <main className="studio-layout">
      <aside className="left-panel">
        <span className="section-kicker">YOUR WORKSPACE</span>
        <h1>App blueprint</h1>
        <p className="intro">From a rough idea to a working app, one detail at a time.</p>
        {creating || !snapshot?.blueprints.length ? <div className="new-blueprint">
          <label className="field-label" htmlFor="idea">What do you want to build?</label>
          <div className="prompt-field">
            <textarea id="idea" autoFocus value={idea} maxLength={2000} placeholder="A booking app for personal trainers where clients can…" onChange={event => setIdea(event.target.value)}
              onKeyDown={event => { if (event.key === 'Enter' && (event.ctrlKey || event.metaKey) && idea.trim().length >= 3) void createBlueprint() }} />
            <span>CTRL + ENTER TO START</span>
          </div>
          <div className="prompt-suggestions">{ideas.map(item => <button key={item} onClick={() => setIdea(item)}>{item}</button>)}</div>
          <button className="primary full" disabled={idea.trim().length < 3 || !!busy} onClick={() => void createBlueprint()}><Sparkles size={15} />Start blueprint<ArrowRight size={15} /></button>
          {!!snapshot?.blueprints.length && <button className="text-button full" onClick={() => setCreating(false)}>Cancel</button>}
        </div> : <button className="import-button" onClick={() => setCreating(true)}><Plus size={16} />New blueprint<span>FROM AN IDEA</span></button>}

        <div className="steps">
          {steps.map((item, index) => <div key={item.title} className={`step ${index < step ? 'ready' : ''} ${index === step ? 'current' : ''}`}>
            <span className="step-number">{index < step ? <Check size={13} /> : `0${index + 1}`}</span>
            <span><strong>{item.title}</strong><small>{item.detail}</small></span>
            {item.icon}
          </div>)}
        </div>
        <div className="panel-rule" />
        <div className="section-heading"><span className="section-kicker">BLUEPRINTS<span className="count">{snapshot?.blueprints.length ?? 0}</span></span></div>
        <div className="asset-list">
          {snapshot?.blueprints.map(item => <div key={item.id} className={`asset ${item.id === activeId ? 'active' : ''}`}>
            <button className="asset-open" onClick={() => openBlueprint(item.id)}>
              <span className="asset-icon"><FolderKanban size={17} /></span>
              <span><strong>{item.name}</strong><small>{item.nodes.length} nodes · {new Date(item.updatedAt).toLocaleDateString()}</small></span>
            </button>
            {item.id === activeId && <button className="icon-button" title="Delete blueprint" aria-label={`Delete ${item.name}`} onClick={() => { if (confirm(`Delete "${item.name}"? Built output on disk is kept.`)) void window.studio.deleteBlueprint(item.id).catch(reason => setError(errorText(reason))) }}><Trash2 size={14} /></button>}
          </div>)}
          {!snapshot?.blueprints.length && <div className="empty-assets"><Network size={26} /><p>No blueprints yet.</p><small>Describe an idea to grow your first map.</small></div>}
        </div>
        <div className="local-note"><ShieldCheck size={17} /><div><strong>Your subscription, your machine.</strong><p>Agents run through the CLI you already sign in to. App Studio never stores credentials.</p></div></div>
      </aside>

      {tab === 'map' ? <>
        <section className="center-panel">
          <div className="scene-heading">
            <div><span className="section-kicker">MIND MAP</span><h2>{draft?.name ?? 'No blueprint open'}{draft && <span className="file-tag">{draft.nodes.length} NODES</span>}</h2></div>
            {draft && selected && <div className="view-tabs">
              <button disabled={locked} onClick={() => setSelectedId(addChild(selected.id))}><Plus size={13} />Add child</button>
              <button disabled={locked || !!busy} onClick={() => void suggest(selected)}><Sparkles size={13} />Suggest branches</button>
              <button disabled={locked} onClick={() => { commit(tidyLayout); setFitSignal(value => value + 1) }}><Network size={13} />Tidy</button>
            </div>}
          </div>
          <div className="viewport">
            {draft ? <MindMap blueprint={draft} selectedId={selected?.id} locked={locked} fitSignal={fitSignal} onSelect={setSelectedId} onAddChild={id => setSelectedId(addChild(id))}
              onMove={(id, position) => updateNode(id, { position })} /> : <div className="empty-viewport">
              <div className="map-outline"><Network size={46} strokeWidth={1.2} /></div>
              <h2>Every app starts as a single node.</h2>
              <p>Describe your idea on the left. AI will help you branch it into<br />features, screens, data and rules — then ask what it needs to know.</p>
              <span>IDEA → MIND MAP → QUESTIONS → AGENTS</span>
            </div>}
            {busy && <div className="viewport-notice"><LoaderCircle size={14} className="spin" />{busy}…</div>}
            {suggestions && <SuggestionTray items={suggestions.items} onAccept={acceptSuggestions} onClose={() => setSuggestions(undefined)} />}
            {draft && <div className="viewport-hint">Click a node to detail it · + adds a child · drag to arrange</div>}
          </div>
          {draft && <div className="gaps">
            <span className="section-kicker">NEEDS DETAIL<span className="count">{stats.gaps.length}</span></span>
            <div className="gap-list">
              {stats.gaps.slice(0, 12).map(node => <button key={node.id} onClick={() => setSelectedId(node.id)} className={node.id === selected?.id ? 'selected' : ''}>{node.title}<small>{completeness(node).percent}%</small></button>)}
              {!stats.gaps.length && <p className="all-ready"><Check size={13} />Every node is answered and has acceptance criteria. Review the build plan when ready.</p>}
            </div>
          </div>}
        </section>
        <aside className="right-panel">
          {draft && selected ? <Inspector key={selected.id} node={selected} blueprint={draft} locked={locked} busy={!!busy} onChange={patch => updateNode(selected.id, patch)}
            onInterview={() => void interview(selected)} onDraftCriteria={() => void draftCriteria(selected)} onSuggest={() => void suggest(selected)}
            onDelete={() => deleteNode(selected.id)} onAddChild={() => setSelectedId(addChild(selected.id))} /> :
            <div className="inspector-empty"><span className="section-kicker">02 / DETAIL NODE</span><h2>Nothing selected</h2><p className="panel-description">Create a blueprint, then select a node to answer AI questions about it.</p></div>}
          {error && <div className="banner error" role="alert"><X size={14} /><span>{error}</span><button onClick={() => setError(undefined)} aria-label="Dismiss error"><X size={13} /></button></div>}
        </aside>
      </> : <>
        <BuildCenter blueprint={draft} run={run?.blueprintId === draft?.id ? run : undefined} />
        <aside className="right-panel">
          <BuildPanel blueprint={draft} run={run} settings={settings} provider={provider} gaps={stats.gaps}
            onJump={id => { setSelectedId(id); setTab('map') }} onError={setError} onOpenSettings={() => setSettingsOpen(true)} />
          {error && <div className="banner error" role="alert"><X size={14} /><span>{error}</span><button onClick={() => setError(undefined)} aria-label="Dismiss error"><X size={13} /></button></div>}
        </aside>
      </>}
    </main>

    <footer>
      <span><ShieldCheck size={11} />LOCAL CLI AGENTS</span>
      <span>Idea <ArrowRight size={9} /> Mind map <ArrowRight size={9} /> AI interview <ArrowRight size={9} /> Build plan <ArrowRight size={9} /> Sub-agents</span>
      <span>{provider ? provider.label.toUpperCase() : 'NO MODEL'}{settings ? ` · ${settings.maxParallelAgents} PARALLEL` : ''}</span>
    </footer>

    {settingsOpen && settings && <SettingsModal settings={settings} providers={providers} onClose={() => setSettingsOpen(false)}
      onRefresh={async () => setProviders(await window.studio.providers())} onSaved={next => setSnapshot(current => current && { ...current, settings: next })} />}
  </div>
}

function SuggestionTray({ items, onAccept, onClose }: { items: BranchSuggestion[]; onAccept: (items: BranchSuggestion[]) => void; onClose: () => void }) {
  const [picked, setPicked] = useState(() => new Set(items.map((_, index) => index)))
  return <div className="suggestion-tray" role="dialog" aria-label="Suggested branches">
    <div className="tray-heading"><span className="section-kicker">SUGGESTED BRANCHES</span><button className="icon-button" onClick={onClose} aria-label="Close suggestions"><X size={14} /></button></div>
    {items.map((item, index) => <label key={item.title} className="suggestion">
      <input type="checkbox" checked={picked.has(index)} onChange={() => setPicked(current => { const next = new Set(current); if (next.has(index)) next.delete(index); else next.add(index); return next })} />
      <span><strong>{item.title}<em>{item.kind}</em></strong><small>{item.summary}</small></span>
    </label>)}
    <button className="primary full" disabled={!picked.size} onClick={() => onAccept(items.filter((_, index) => picked.has(index)))}><Plus size={14} />Add {picked.size} to map</button>
  </div>
}
