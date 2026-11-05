import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ArrowRight, Check, Cpu, FolderKanban, Hammer, LoaderCircle, MessageCircleQuestion, Network, Pencil, Plus, ShieldCheck, Sparkles, Trash2, Workflow, X } from 'lucide-react'
import { MindMap } from './MindMap'
import { Inspector } from './Inspector'
import { RelationshipInspector } from './RelationshipInspector'
import { BuildCenter, BuildPanel } from './BuildView'
import { SettingsModal } from './SettingsModal'
import { blueprintGaps, completeness, defaultConnection, descendantIds, kindLabels, planBuild } from '../shared/plan'
import { childPosition, tidyLayout } from '../shared/layout'
import { blueprintSchema, type Blueprint, type BranchSuggestion, type MindNode, type NodeConnection, type NodeKind, type ProjectAction, type ProviderInfo, type Snapshot } from '../shared/types'
import { desktopCommandSchema, type DesktopCommand, type MapControl } from '../shared/automation'

export const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error)).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
const newId = () => crypto.randomUUID().replace(/-/g, '').slice(0, 16)
const ideas = ['A booking app for personal trainers', 'A shared grocery list for families', 'An internal tool to track laptop loans']

export function statusFor(node: MindNode, previous?: MindNode): MindNode['status'] {
  if (['queued', 'building'].includes(node.status)) return node.status
  const content = (item: MindNode) => JSON.stringify([item.kind, item.title, item.summary, item.questions, item.acceptance, item.analysis])
  if (['built', 'failed'].includes(node.status) && previous && content(previous) === content(node)) return node.status
  return completeness(node).ready ? 'ready' : 'draft'
}

export function App() {
  const [snapshot, setSnapshot] = useState<Snapshot>()
  const [activeId, setActiveId] = useState<string>()
  const [draft, setDraft] = useState<Blueprint>()
  const [selectedId, setSelectedId] = useState<string>()
  const [selectedEdgeId, setSelectedEdgeId] = useState<string>()
  const [tab, setTab] = useState<'map' | 'build'>('map')
  const [fitSignal, setFitSignal] = useState(0)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const settingsDirty = useRef(false)
  const onSettingsDirtyChange = useCallback((value: boolean) => { settingsDirty.current = value }, [])
  const [selectedTaskId, setSelectedTaskId] = useState<string>()
  const mapControl = useRef<MapControl>(undefined)
  const onMapControl = useCallback((control: MapControl | undefined) => { mapControl.current = control }, [])
  const [providers, setProviders] = useState<ProviderInfo[]>([])
  const [error, setError] = useState<string>()
  const [localBusy, setBusy] = useState<string>()
  const [remoteActive, setRemoteActive] = useState(false)
  const remoteRef = useRef(false)
  const busy = localBusy || (remoteActive ? 'Agent control' : undefined)
  const [notice, setNotice] = useState<string>()
  const busyRef = useRef(false)
  const [idea, setIdea] = useState('')
  const [creating, setCreating] = useState(false)
  const [renaming, setRenaming] = useState<{ id: string; name: string }>()
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
    if (!dirty.current) setDraft(next.blueprints.find(item => item.id === id))
    else if (building && draftRef.current?.id === id) {
      const saved = next.blueprints.find(item => item.id === id)
      const merged = { ...draftRef.current, nodes: draftRef.current.nodes.map(node => ({ ...node, status: saved?.nodes.find(item => item.id === node.id)?.status ?? node.status })) }
      draftRef.current = merged
      setDraft(merged)
    }
  }, [])

  useEffect(() => {
    window.studio.snapshot().then(apply).catch(reason => setError(errorText(reason)))
    window.studio.providers().then(setProviders).catch(() => undefined)
    return window.studio.onUpdate(apply)
  }, [apply])

  const run = snapshot?.run
  const projectActivity = snapshot?.projectActivity
  const locked = !!snapshot?.buildStarting || (!!draft && run?.status === 'running' && run.blueprintId === draft.id)
  const editingLocked = locked || !!busy
  const settings = snapshot?.settings
  const provider = providers.find(item => item.id === settings?.provider)
  const model = settings ? settings.selectedModel[settings.provider] : ''
  const selected = draft?.nodes.find(node => node.id === selectedId) ?? draft?.nodes.find(node => node.parentId === null)
  const currentBuildIds = new Set(run?.nodeIds ?? run?.tasks.map(task => task.nodeId) ?? [])
  const selectedLocked = !!busy || !!snapshot?.buildStarting || (locked && !!selected && currentBuildIds.has(selected.id))
  const selectedConnection = draft?.connections.find(link => `link-${link.id}` === selectedEdgeId)
  const selectedChild = draft?.nodes.find(node => node.parentId && `child-${node.id}` === selectedEdgeId)
  const relationshipLocked = !!busy || !!snapshot?.buildStarting || locked && (selectedChild
    ? currentBuildIds.has(selectedChild.id)
    : !!selectedConnection && currentBuildIds.has(selectedConnection.sourceId) && currentBuildIds.has(selectedConnection.targetId))
  useEffect(() => setNotice(undefined), [selected?.id])

  const commit = useCallback((change: (blueprint: Blueprint) => Blueprint) => {
    const current = draftRef.current
    if (!current) return
    const parsed = blueprintSchema.safeParse(change(structuredClone(current)))
    if (!parsed.success) {
      const message = parsed.error.issues[0]?.message ?? 'Invalid blueprint.'
      setError(message)
      if (remoteRef.current) throw new Error(message)
      return
    }
    const next = parsed.data
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
    return next
  }, [])

  const updateNode = useCallback((id: string, patch: Partial<MindNode>) => {
    commit(blueprint => ({ ...blueprint, name: blueprint.nameSource !== 'manual' && blueprint.nodes.find(node => node.id === id)?.parentId === null && patch.title ? patch.title : blueprint.name, nodes: blueprint.nodes.map(node => node.id === id ? { ...node, ...patch, ...(['title', 'summary', 'kind', 'parentId'].some(key => key in patch) ? { analysis: undefined } : {}) } : node) }))
  }, [commit])

  const tidy = useCallback(() => {
    commit(blueprint => tidyLayout(blueprint, mapControl.current?.getNodeSizes()))
    setFitSignal(value => value + 1)
  }, [commit])

  const addChild = useCallback((parentId: string, kind: NodeKind = 'unspecified', title = 'New node', summary = '', position?: MindNode['position']) => {
    const id = newId()
    commit(blueprint => ({ ...blueprint, nodes: [...blueprint.nodes, { id, parentId, kind, title, titleSource: 'auto', summary, questions: [], acceptance: [], status: 'draft', position: position ?? childPosition(blueprint, parentId) }] }))
    setSelectedEdgeId(undefined)
    return id
  }, [commit])

  const deleteNode = useCallback((id: string) => {
    commit(blueprint => {
      const gone = descendantIds(blueprint, id)
      gone.add(id)
      return { ...blueprint, nodes: blueprint.nodes.filter(node => !gone.has(node.id) || node.parentId === null), connections: blueprint.connections.filter(link => !gone.has(link.sourceId) && !gone.has(link.targetId)) }
    })
    setSelectedId(undefined)
  }, [commit])

  async function withBusy<T>(label: string, work: () => Promise<T>) {
    if (busyRef.current) { if (remoteRef.current) throw new Error('An AI request is already running.'); return }
    busyRef.current = true
    setBusy(label); setError(undefined); setNotice(undefined); setSuggestions(undefined)
    try { return await work() } catch (reason) {
      setError(errorText(reason))
      if (remoteRef.current) throw reason
      return undefined
    } finally { busyRef.current = false; setBusy(undefined) }
  }

  async function persist(blueprint: Blueprint) {
    clearTimeout(saveTimer.current)
    const stamp = version.current
    const saved = await window.studio.saveBlueprint(blueprint)
    if (version.current === stamp && activeRef.current === blueprint.id) {
      dirty.current = false
      draftRef.current = saved
      setDraft(saved)
    }
  }

  async function startProject(action: ProjectAction) {
    return withBusy('Starting project action', async () => {
      const blueprint = draftRef.current
      if (!blueprint) throw new Error('Open a blueprint first.')
      if (dirty.current) await persist(blueprint)
      const result = await window.studio.startProject(blueprint.id, action)
      setTab('build')
      return result
    })
  }

  async function renameBlueprint(id: string, name: string) {
    return withBusy('Renaming blueprint', async () => {
      if (dirty.current && draftRef.current) await persist(draftRef.current)
      const saved = await window.studio.renameBlueprint(id, name)
      if (activeRef.current === id) { draftRef.current = saved; setDraft(saved) }
      setRenaming(undefined)
      apply(await window.studio.snapshot())
      return saved
    })
  }

  const stopProject = () => withBusy('Stopping project action', () => window.studio.stopProject())
  const openProject = () => withBusy('Opening preview', async () => {
    if (!draftRef.current) throw new Error('Open a blueprint first.')
    await window.studio.openProject(draftRef.current.id)
  })

  async function analyze(node: MindNode, blueprint = draftRef.current) {
    if (!blueprint) return
    await withBusy(`Analyzing ${node.title}`, async () => {
      await persist(blueprint)
      const result = await window.studio.analyzeNode(blueprint, node.id).catch(reason => {
        throw new Error(`Node saved, but AI analysis failed. Use Save & analyze to retry. ${errorText(reason)}`)
      })
      if (draftRef.current?.id !== blueprint.id) return
      const next = commit(current => ({ ...current, name: node.parentId === null && current.nameSource !== 'manual' ? result.title : current.name, nodes: current.nodes.map(item => {
        if (item.id !== node.id) return item
        const questions = [...item.questions, ...result.questions]
        return { ...item, title: result.title, kind: result.kind, questions, analysis: { title: result.title, summary: item.summary, kind: result.kind, message: result.message, noFollowUps: questions.length === 0 } }
      }) }))
      if (!next) throw new Error('Analysis could not be applied. Your saved node is unchanged.')
      await persist(next)
      setNotice(`Saved & analyzed. ${result.questions.length ? `Added ${result.questions.length} follow-up question(s).` : 'No new follow-up questions needed.'}`)
    })
  }

  async function answerQuestion(node: MindNode, questionId: string) {
    const blueprint = draftRef.current
    if (!blueprint) return
    const answer = node.questions.find(item => item.id === questionId)?.answer
    if (!answer?.trim()) return
    await withBusy(`Reviewing your answer for ${node.title}`, async () => {
      await persist(blueprint)
      const result = await window.studio.answerQuestion(blueprint, node.id, questionId).catch(reason => {
        throw new Error(`Answer saved, but AI review failed. Press Answer to retry. ${errorText(reason)}`)
      })
      if (draftRef.current?.id !== blueprint.id) return
      const next = commit(current => {
        const focus = current.nodes.find(item => item.id === node.id)!
        focus.questions = [...focus.questions.map(item => item.id === questionId ? { ...item, reviewedAnswer: answer } : item), ...result.questions]
        for (const branch of result.branches) current.nodes.push({
          ...branch, id: newId(), parentId: node.id, titleSource: 'auto', questions: [], acceptance: [], status: 'draft', position: childPosition(current, node.id)
        })
        return current
      })
      if (!next) throw new Error('The answer expansion could not be applied. Your saved answer is unchanged.')
      await persist(next)
      setNotice(`Answer reviewed. Added ${result.branches.length} child node(s) and ${result.questions.length} follow-up question(s).`)
    })
  }

  function canEditConnection(link: Pick<NodeConnection, 'sourceId' | 'targetId'>) {
    if (locked && currentBuildIds.has(link.sourceId) && currentBuildIds.has(link.targetId)) {
      const message = 'Stop the active build before changing relationships between its existing nodes. You can connect newly added nodes for the next rebuild.'
      setError(message)
      if (remoteRef.current) throw new Error(message)
      return false
    }
    return true
  }

  function addConnection(link: Omit<NodeConnection, 'id' | 'kind'> & { kind?: NodeConnection['kind'] }) {
    if (!canEditConnection(link)) return
    const id = newId()
    const result = commit(blueprint => {
      const connection = link.kind ? { ...link, kind: link.kind, id } : defaultConnection(blueprint, { sourceId: link.sourceId, targetId: link.targetId, id })
      return { ...blueprint, connections: [...blueprint.connections, connection] }
    })
    if (result) { setSelectedEdgeId(`link-${id}`); setNotice(undefined) }
  }

  function updateConnection(id: string, patch: Partial<Omit<NodeConnection, 'id'>>) {
    const before = draftRef.current?.connections.find(link => link.id === id)
    if (!before || !canEditConnection(before) || !canEditConnection({ ...before, ...patch })) return
    commit(blueprint => ({ ...blueprint, connections: blueprint.connections.map(link => link.id === id ? { ...link, ...patch } : link) }))
  }

  function removeConnection(id: string) {
    const before = draftRef.current?.connections.find(link => link.id === id)
    if (!before || !canEditConnection(before)) return
    commit(blueprint => ({ ...blueprint, connections: blueprint.connections.filter(link => link.id !== id) }))
    setSelectedEdgeId(undefined)
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

  async function createBlueprint(text = idea, shouldAnalyze = true) {
    const blueprint = await withBusy('Creating blueprint', () => window.studio.createBlueprint(text))
    if (!blueprint) return
    activeRef.current = blueprint.id
    draftRef.current = blueprint
    dirty.current = false
    setActiveId(blueprint.id); setDraft(blueprint); setSelectedId(blueprint.nodes[0].id); setSelectedEdgeId(undefined); setIdea(''); setCreating(false); setTab('map')
    if (shouldAnalyze) await analyze(blueprint.nodes[0], blueprint)
  }

  function openBlueprint(id: string) {
    clearTimeout(saveTimer.current)
    if (dirty.current && draftRef.current) void window.studio.saveBlueprint(draftRef.current).catch(reason => setError(errorText(reason)))
    dirty.current = false
    activeRef.current = id
    draftRef.current = snapshot?.blueprints.find(item => item.id === id)
    setNotice(undefined)
    setActiveId(id); setDraft(draftRef.current); setSelectedId(undefined); setSelectedEdgeId(undefined); setSuggestions(undefined)
  }

  const desktopState = useRef<unknown>(undefined)
  desktopState.current = {
    activeBlueprintId: activeId, selectedNodeId: selected?.id, selectedEdgeId, tab, selectedTaskId, settingsOpen,
    settingsHaveUnsavedEdits: settingsDirty.current, suggestions, error, notice, busy: localBusy,
    draft, providers, gaps: draft ? blueprintGaps(draft).map(node => node.id) : [], plan: draft ? planBuild(draft) : []
  }

  async function controlDesktop(input: DesktopCommand): Promise<unknown> {
    const command = desktopCommandSchema.parse(input)
    if (command.action === 'studio_get_state') {
      const saved = await window.studio.snapshot()
      const { state, endpoint, error } = await window.studio.mcpStatus()
      const pendingNodeTitle = document.querySelector<HTMLInputElement>('.title-input')?.value
      return { snapshot: saved, desktop: desktopState.current, pendingNodeTitle, viewport: mapControl.current?.getViewport(), mcp: { state, endpoint, error }, hasUnsavedBlueprintEdits: dirty.current || (pendingNodeTitle !== undefined && pendingNodeTitle !== selected?.title) }
    }
    if (remoteRef.current || busyRef.current) throw new Error('The desktop is busy. Wait for the current operation.')
    if (settingsOpen && !['mcp_copy_config', 'desktop_scroll', 'desktop_set_view', 'desktop_dismiss_error', 'build_cancel', 'project_stop'].includes(command.action))
      throw new Error('Close Model & agents before using workflow tools, so unsaved settings are not overwritten.')
    const editable = !['mcp_copy_config', 'settings_update', 'provider_test', 'blueprint_open', 'blueprint_rename', 'node_add', 'desktop_scroll', 'desktop_set_view', 'map_viewport', 'build_cancel', 'build_reveal', 'project_stop', 'project_open', 'providers_refresh', 'desktop_dismiss_error'].includes(command.action)
    remoteRef.current = true
    setRemoteActive(true)
    const current = () => {
      if (!draftRef.current) throw new Error('Open a blueprint first.')
      return draftRef.current
    }
    const findNode = (id: string) => {
      const node = current().nodes.find(item => item.id === id)
      if (!node) throw new Error('Node not found in the active blueprint.')
      return node
    }
    try {
      const live = await window.studio.snapshot()
      const building = live.run?.status === 'running' && live.run.blueprintId === activeRef.current
      const ids = new Set(live.run?.nodeIds ?? live.run?.tasks.map(task => task.nodeId) ?? [])
      const editsNewNode = 'nodeId' in command && command.nodeId !== undefined && !ids.has(command.nodeId)
      const connectsNewNode = command.action === 'connection_add' && (!ids.has(command.connection.sourceId) || !ids.has(command.connection.targetId))
      const removesNewConnection = command.action === 'connection_delete' && current().connections.some(link => link.id === command.connectionId && (!ids.has(link.sourceId) || !ids.has(link.targetId)))
      const changedConnection = command.action === 'connection_update' ? current().connections.find(link => link.id === command.connectionId) : undefined
      const updatesNewConnection = command.action === 'connection_update' && changedConnection &&
        (!ids.has(changedConnection.sourceId) || !ids.has(changedConnection.targetId)) &&
        (!ids.has(command.patch.sourceId ?? changedConnection.sourceId) || !ids.has(command.patch.targetId ?? changedConnection.targetId))
      if (editable && (live.buildStarting || building && !editsNewNode && !connectsNewNode && !removesNewConnection && !updatesNewConnection))
        throw new Error('Nodes in the active build are read-only. Add new nodes for the next rebuild, or stop the build to edit existing nodes.')
      // Commit the inspector's blur-saved title before a tool changes selection or edits the map.
      if (document.activeElement instanceof HTMLInputElement && document.activeElement.classList.contains('title-input'))
        document.activeElement.blur()
      if (dirty.current && draftRef.current) await persist(draftRef.current)
      let result: unknown
      switch (command.action) {
        case 'mcp_copy_config': await window.studio.copyMcpConfig(); break
        case 'blueprint_create': await createBlueprint(command.idea, command.analyze); break
        case 'blueprint_rename': result = await renameBlueprint(command.blueprintId, command.name); break
        case 'blueprint_open': {
          const next = await window.studio.snapshot()
          const blueprint = next.blueprints.find(item => item.id === command.blueprintId)
          if (!blueprint) throw new Error('Blueprint not found.')
          activeRef.current = blueprint.id; draftRef.current = blueprint
          setSnapshot(next); setActiveId(blueprint.id); setDraft(blueprint); setSelectedId(undefined); setSelectedEdgeId(undefined)
          setSuggestions(undefined); setNotice(undefined); setTab('map')
          break
        }
        case 'blueprint_save': {
          const before = current()
          const saved = (await window.studio.snapshot()).blueprints.find(item => item.id === before.id)
          if (command.blueprint.id !== before.id) throw new Error('Open the blueprint before replacing it.')
          if (saved?.updatedAt !== command.expectedUpdatedAt) throw new Error('Blueprint changed. Read studio_get_state and merge your edits before retrying.')
          if (command.blueprint.outputDir !== before.outputDir) throw new Error('Use build_set_output to change the output directory.')
          commit(() => ({
            ...command.blueprint, createdAt: before.createdAt,
            nodes: command.blueprint.nodes.map(node => {
              const previous = before.nodes.find(item => item.id === node.id)
              const changed = previous && ['title', 'summary', 'kind', 'parentId'].some(key => previous[key as keyof MindNode] !== node[key as keyof MindNode])
              return { ...node, titleSource: previous?.title !== node.title ? 'manual' : previous.titleSource,
                analysis: changed ? undefined : previous?.analysis, status: previous?.status ?? 'draft' }
            })
          }))
          break
        }
        case 'blueprint_delete':
          await window.studio.deleteBlueprint(command.blueprintId)
          apply(await window.studio.snapshot())
          break
        case 'node_add': {
          findNode(command.parentId)
          const id = addChild(command.parentId, command.kind, command.title, command.summary, command.position)
          if (command.title) updateNode(id, { titleSource: 'manual' })
          setSelectedId(id); result = { nodeId: id }
          break
        }
        case 'node_update':
          findNode(command.nodeId)
          updateNode(command.nodeId, { ...command.patch, ...(command.patch.title !== undefined ? { titleSource: 'manual' as const } : {}) })
          break
        case 'node_rename':
          findNode(command.nodeId)
          updateNode(command.nodeId, { title: command.title, titleSource: 'manual' })
          break
        case 'node_delete':
          if (findNode(command.nodeId).parentId === null) throw new Error('Delete the blueprint to remove its root.')
          deleteNode(command.nodeId)
          break
        case 'connection_add': current(); addConnection(command.connection); break
        case 'connection_update':
          if (!current().connections.some(link => link.id === command.connectionId)) throw new Error('Connection not found.')
          updateConnection(command.connectionId, command.patch)
          break
        case 'connection_delete':
          if (!current().connections.some(link => link.id === command.connectionId)) throw new Error('Connection not found.')
          removeConnection(command.connectionId)
          break
        case 'node_analyze': await analyze(findNode(command.nodeId)); break
        case 'node_interview': await interview(findNode(command.nodeId)); break
        case 'question_answer': {
          const node = findNode(command.nodeId)
          if (!node.questions.some(question => question.id === command.questionId)) throw new Error('Question not found.')
          updateNode(node.id, { questions: node.questions.map(question => question.id === command.questionId ? { ...question, answer: command.answer } : question) })
          await answerQuestion(findNode(node.id), command.questionId)
          break
        }
        case 'branches_suggest': await suggest(findNode(command.nodeId)); break
        case 'branches_accept':
          if (!suggestions) throw new Error('Request branch suggestions first.')
          if (command.indices.some(index => !suggestions.items[index])) throw new Error('Suggestion index out of range.')
          if (current().nodes.length + new Set(command.indices).size > 400) throw new Error('The blueprint would exceed 400 nodes.')
          acceptSuggestions([...new Set(command.indices)].map(index => suggestions.items[index]))
          break
        case 'branches_dismiss': setSuggestions(undefined); break
        case 'acceptance_draft': await draftCriteria(findNode(command.nodeId)); break
        case 'map_tidy': current(); tidy(); break
        case 'map_viewport':
          if (!mapControl.current || tab !== 'map') throw new Error('Open the Blueprint view first.')
          if (command.viewport) await mapControl.current.setViewport(command.viewport)
          else await mapControl.current.fitView()
          break
        case 'desktop_scroll': {
          const selectors = { workspace: '.left-panel', inspector: '.right-panel', center: '.center-panel', settings: '.settings-modal', log: '.agent-log pre', projectLog: '.project-log pre' }
          const panel = document.querySelector<HTMLElement>(selectors[command.panel])
          if (!panel) throw new Error('Open the requested panel before scrolling it.')
          panel.scrollTop = command.top
          result = { top: panel.scrollTop, scrollHeight: panel.scrollHeight, clientHeight: panel.clientHeight }
          break
        }
        case 'desktop_set_view':
          if (command.settingsOpen === false && settingsDirty.current && !command.discardSettingsEdits)
            throw new Error('Settings have unsaved edits. Save them in the dialog or explicitly allow discarding them.')
          if (command.nodeId) { findNode(command.nodeId); setSelectedId(command.nodeId); setSelectedEdgeId(undefined) }
          if (command.edgeId) {
            if (!current().connections.some(link => `link-${link.id}` === command.edgeId) && !current().nodes.some(node => node.parentId && `child-${node.id}` === command.edgeId))
              throw new Error('Relationship line not found.')
            setSelectedEdgeId(command.edgeId)
          }
          if (command.taskId) {
            const state = await window.studio.snapshot()
            const tasks = state.run?.blueprintId === current().id ? state.run.tasks : planBuild(current())
            if (!tasks.some(task => task.id === command.taskId)) throw new Error('Build task not found.')
            setSelectedTaskId(command.taskId)
          }
          if (command.tab) setTab(command.tab)
          if (command.settingsOpen !== undefined) setSettingsOpen(command.settingsOpen)
          break
        case 'settings_update': {
          const state = await window.studio.snapshot()
          const settings = await window.studio.saveSettings({
            ...state.settings, ...command.patch,
            models: { ...state.settings.models, ...command.patch.models },
            selectedModel: { ...state.settings.selectedModel, ...command.patch.selectedModel },
            binaryPaths: { ...state.settings.binaryPaths, ...command.patch.binaryPaths }
          })
          setSnapshot(previous => previous && { ...previous, settings })
          const status = await window.studio.mcpStatus()
          if (status.state === 'error') throw new Error(`Settings saved, but MCP could not start: ${status.error}`)
          break
        }
        case 'providers_refresh': {
          const next = await window.studio.providers(); setProviders(next); result = next; break
        }
        case 'provider_test': result = await withBusy('Testing provider', () => window.studio.testProvider()); break
        case 'build_set_output': {
          const next = await window.studio.setOutputDir(current().id, command.directory)
          draftRef.current = next; setDraft(next)
          break
        }
        case 'build_start': {
          const blueprint = current()
          if (blueprintGaps(blueprint).length && !command.allowGaps) throw new Error('Nodes still need detail. Complete them or explicitly use allowGaps (Build anyway).')
          const state = await window.studio.snapshot()
          const available = await window.studio.providers()
          setProviders(available)
          if (!available.find(provider => provider.id === state.settings.provider)?.installed) throw new Error('The selected provider is not available.')
          result = await window.studio.startBuild(blueprint.id)
          setTab('build')
          break
        }
        case 'build_cancel': await window.studio.cancelBuild(); break
        case 'build_reveal': await window.studio.revealOutput(current().id); break
        case 'project_build': result = await startProject('build'); break
        case 'project_run': result = await startProject('run'); break
        case 'project_stop': await stopProject(); break
        case 'project_open': await openProject(); break
        case 'desktop_dismiss_error': setError(undefined); break
        default: { const exhaustive: never = command; throw new Error(`Unsupported desktop command: ${exhaustive}`) }
      }
      if (dirty.current && draftRef.current) await persist(draftRef.current)
      const saved = await window.studio.snapshot()
      const { state, endpoint, error: mcpError } = await window.studio.mcpStatus()
      // Let React commit view/selection changes before reporting the resulting desktop state.
      await new Promise(resolve => setTimeout(resolve, 0))
      return { result, snapshot: saved, desktop: desktopState.current, viewport: mapControl.current?.getViewport(), mcp: { state, endpoint, error: mcpError } }
    } catch (reason) {
      setError(errorText(reason))
      throw reason
    } finally { remoteRef.current = false; setRemoteActive(false) }
  }

  const commandHandler = useRef(controlDesktop)
  commandHandler.current = controlDesktop
  useEffect(() => window.studio.onCommand(command => commandHandler.current(command)), [])

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
    { title: 'Build with agents', detail: 'Code nodes + instructions', icon: <Hammer size={15} /> }
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
        <button className={tab === 'build' ? 'active' : ''} disabled={!!busy} onClick={() => {
          if (!draftRef.current || !dirty.current) { setTab('build'); return }
          void withBusy('Saving blueprint', async () => { await persist(draftRef.current!); setTab('build') })
        }}>Build</button>
      </nav>
      <button className={`connection ${provider && !provider.installed ? 'warning' : ''}`} disabled={!!busy} onClick={() => setSettingsOpen(true)} title="Model settings">
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
            <textarea id="idea" autoFocus disabled={!!busy} value={idea} maxLength={2000} placeholder="A booking app for personal trainers where clients can…" onChange={event => setIdea(event.target.value)}
              onKeyDown={event => { if (event.key === 'Enter' && (event.ctrlKey || event.metaKey) && idea.trim().length >= 3) void createBlueprint() }} />
            <span>CTRL + ENTER TO START</span>
          </div>
          <div className="prompt-suggestions">{ideas.map(item => <button key={item} onClick={() => setIdea(item)}>{item}</button>)}</div>
          <button className="primary full" disabled={idea.trim().length < 3 || !!busy} onClick={() => void createBlueprint()}><Sparkles size={15} />Start blueprint<ArrowRight size={15} /></button>
          {!!snapshot?.blueprints.length && <button className="text-button full" onClick={() => setCreating(false)}>Cancel</button>}
        </div> : <button className="import-button" disabled={!!busy} onClick={() => setCreating(true)}><Plus size={16} />New blueprint<span>FROM AN IDEA</span></button>}

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
            {renaming?.id === item.id ? <form className="asset-rename" onSubmit={event => { event.preventDefault(); void renameBlueprint(item.id, renaming.name) }}>
              <input aria-label="Blueprint name" autoFocus maxLength={120} value={renaming.name} onChange={event => setRenaming({ id: item.id, name: event.target.value })} onKeyDown={event => { if (event.key === 'Escape') setRenaming(undefined) }} />
              <button type="submit" className="icon-button" disabled={!!busy || !renaming.name.trim()} aria-label="Save blueprint name"><Check size={14} /></button>
              <button type="button" className="icon-button" aria-label="Cancel rename" onClick={() => setRenaming(undefined)}><X size={14} /></button>
            </form> : <>
            <button className="asset-open" disabled={!!busy} onClick={() => openBlueprint(item.id)}>
              <span className="asset-icon"><FolderKanban size={17} /></span>
              <span><strong>{item.name}</strong><small>{item.nodes.length} nodes · {new Date(item.updatedAt).toLocaleDateString()}</small></span>
            </button>
            <button className="icon-button" disabled={!!busy} title="Rename blueprint" aria-label={`Rename ${item.name}`} onClick={() => setRenaming({ id: item.id, name: item.name })}><Pencil size={14} /></button>
            {item.id === activeId && <button className="icon-button" disabled={editingLocked} title="Delete blueprint" aria-label={`Delete ${item.name}`} onClick={() => { if (confirm(`Delete "${item.name}"? Built output on disk is kept.`)) void window.studio.deleteBlueprint(item.id).catch(reason => setError(errorText(reason))) }}><Trash2 size={14} /></button>}
            </>}
          </div>)}
          {!snapshot?.blueprints.length && <div className="empty-assets"><Network size={26} /><p>No blueprints yet.</p><small>Describe an idea to grow your first map.</small></div>}
        </div>
        <div className="local-note"><ShieldCheck size={17} /><div><strong>Your subscription, your machine.</strong><p>Agents run through a CLI you already sign in to, or a model on your own server. App Studio never stores credentials.</p></div></div>
      </aside>

      {tab === 'map' ? <>
        <section className="center-panel">
          <div className="scene-heading">
            <div><span className="section-kicker">MIND MAP</span><h2>{draft?.name ?? 'No blueprint open'}{draft && <span className="file-tag">{draft.nodes.length} NODES</span>}</h2></div>
            {draft && selected && <div className="view-tabs">
              <button disabled={draft.nodes.length >= 400} onClick={() => setSelectedId(addChild(selected.id))}><Plus size={13} />Add child</button>
              <button disabled={locked || !!busy} onClick={() => void suggest(selected)}><Sparkles size={13} />Suggest branches</button>
              <button disabled={editingLocked} onClick={tidy}><Network size={13} />Tidy</button>
            </div>}
          </div>
          {locked && <p className="plan-note">The active build keeps its original task plan. Add and detail new nodes now; they will be included in the next rebuild.</p>}
          {draft && <div className="map-legend" aria-label="Connection legend">
            <span className="legend-child">Child feature</span><span className="legend-dependency">Output → input</span><span className="legend-similar">Similar features</span>
          </div>}
          <div className="viewport">
            {draft ? <MindMap blueprint={draft} selectedId={selected?.id} selectedEdgeId={selectedEdgeId} locked={editingLocked} fitSignal={fitSignal}
              onSelect={id => { setSelectedId(id); setSelectedEdgeId(undefined) }} onSelectEdge={id => { setSelectedEdgeId(id); setNotice(undefined) }}
              onAddChild={(id, position) => setSelectedId(addChild(id, undefined, undefined, undefined, position))}
              onConnect={(sourceId, targetId) => addConnection({ sourceId, targetId })} onControl={onMapControl}
              onMove={(id, position) => updateNode(id, { position })} /> : <div className="empty-viewport">
              <div className="map-outline"><Network size={46} strokeWidth={1.2} /></div>
              <h2>Every app starts as a single node.</h2>
              <p>Describe your idea on the left. AI will help you branch it into<br />features, screens, data and rules — then ask what it needs to know.</p>
              <span>IDEA → MIND MAP → QUESTIONS → AGENTS</span>
            </div>}
            {busy && <div className="viewport-notice"><LoaderCircle size={14} className="spin" />{busy}…</div>}
            {suggestions && <SuggestionTray items={suggestions.items} onAccept={acceptSuggestions} onClose={() => setSuggestions(undefined)} />}
            {draft && <div className="viewport-hint">Click + to add · Drag + to add or link · Click a line for properties</div>}
          </div>
          {draft && <div className="gaps">
            <span className="section-kicker">NEEDS DETAIL<span className="count">{stats.gaps.length}</span></span>
            <div className="gap-list">
              {stats.gaps.slice(0, 12).map(node => <button key={node.id} onClick={() => { setSelectedId(node.id); setSelectedEdgeId(undefined) }} className={node.id === selected?.id ? 'selected' : ''}>{node.title}<small>{completeness(node).percent}%</small></button>)}
              {!stats.gaps.length && <p className="all-ready"><Check size={13} />Every node is reviewed and has the detail it needs. Review the build plan when ready.</p>}
            </div>
          </div>}
        </section>
        <aside className="right-panel">
          {error && <div className="banner error" role="alert"><X size={14} /><span>{error}</span><button onClick={() => setError(undefined)} aria-label="Dismiss error"><X size={13} /></button></div>}
          {notice && <p className="analysis-notice" role="status">{notice}</p>}
          {draft && (selectedConnection || selectedChild) ? <RelationshipInspector blueprint={draft} connection={selectedConnection} child={selectedChild} locked={relationshipLocked}
            onChange={patch => { if (selectedConnection) updateConnection(selectedConnection.id, patch) }}
            onReparent={parentId => { if (selectedChild) updateNode(selectedChild.id, { parentId }) }}
            onDelete={() => { if (selectedConnection) removeConnection(selectedConnection.id) }} /> : draft && selected ? <Inspector key={selected.id} node={selected} blueprint={draft} locked={selectedLocked} busy={!!busy} onChange={patch => updateNode(selected.id, patch)}
            onAnalyze={() => void analyze(draftRef.current!.nodes.find(item => item.id === selected.id)!)}
            onAnswer={questionId => void answerQuestion(draftRef.current!.nodes.find(item => item.id === selected.id)!, questionId)}
            onConnect={addConnection} onDisconnect={removeConnection}
            onInterview={() => void interview(selected)} onDraftCriteria={() => void draftCriteria(selected)} onSuggest={() => void suggest(selected)}
            onDelete={() => deleteNode(selected.id)} onAddChild={() => setSelectedId(addChild(selected.id))} /> :
            <div className="inspector-empty"><span className="section-kicker">02 / DETAIL NODE</span><h2>Nothing selected</h2><p className="panel-description">Create a blueprint, then select a node to answer AI questions about it.</p></div>}
        </aside>
      </> : <>
        <BuildCenter blueprint={draft} run={run?.blueprintId === draft?.id ? run : undefined}
          projectActivity={projectActivity?.blueprintId === draft?.id ? projectActivity : undefined} selectedId={selectedTaskId} onSelect={setSelectedTaskId} />
        <aside className="right-panel">
          <BuildPanel blueprint={draft} run={run} settings={settings} provider={provider} gaps={stats.gaps}
            disabled={!!busy || !!snapshot?.buildStarting} projectActivity={projectActivity}
            onProjectAction={action => void startProject(action)} onStopProject={() => void stopProject()} onOpenProject={() => void openProject()}
            onJump={id => { setSelectedId(id); setSelectedEdgeId(undefined); setTab('map') }} onError={setError} onOpenSettings={() => setSettingsOpen(true)} />
          {error && <div className="banner error" role="alert"><X size={14} /><span>{error}</span><button onClick={() => setError(undefined)} aria-label="Dismiss error"><X size={13} /></button></div>}
        </aside>
      </>}
    </main>

    <footer>
      <span><ShieldCheck size={11} />{settings?.provider === 'local' ? 'LOCAL MODEL AGENTS' : 'LOCAL CLI AGENTS'}</span>
      <span>Idea <ArrowRight size={9} /> Mind map <ArrowRight size={9} /> AI interview <ArrowRight size={9} /> Build plan <ArrowRight size={9} /> Sub-agents</span>
      <span>{provider ? provider.label.toUpperCase() : 'NO MODEL'}{settings ? ` · ${settings.maxParallelAgents} PARALLEL` : ''}</span>
    </footer>

    {settingsOpen && settings && <SettingsModal settings={settings} providers={providers} onClose={() => setSettingsOpen(false)}
      onDirtyChange={onSettingsDirtyChange}
      onRefresh={async () => setProviders(await window.studio.providers())} onSaved={next => setSnapshot(current => current && { ...current, settings: next })} />}
  </div>
}

function SuggestionTray({ items, onAccept, onClose }: { items: BranchSuggestion[]; onAccept: (items: BranchSuggestion[]) => void; onClose: () => void }) {
  const [picked, setPicked] = useState(() => new Set(items.map((_, index) => index)))
  return <div className="suggestion-tray" role="dialog" aria-label="Suggested branches">
    <div className="tray-heading"><span className="section-kicker">SUGGESTED BRANCHES</span><button className="icon-button" onClick={onClose} aria-label="Close suggestions"><X size={14} /></button></div>
    {items.map((item, index) => <label key={item.title} className="suggestion">
      <input type="checkbox" checked={picked.has(index)} onChange={() => setPicked(current => { const next = new Set(current); if (next.has(index)) next.delete(index); else next.add(index); return next })} />
      <span><strong>{item.title}<em>{kindLabels[item.kind]}</em></strong><small>{item.summary}</small></span>
    </label>)}
    <button className="primary full" disabled={!picked.size} onClick={() => onAccept(items.filter((_, index) => picked.has(index)))}><Plus size={14} />Add {picked.size} to map</button>
  </div>
}
