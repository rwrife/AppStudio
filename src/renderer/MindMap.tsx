import { memo, useEffect, useMemo, useRef } from 'react'
import { Background, BackgroundVariant, Controls, Handle, MarkerType, Position, ReactFlow, ReactFlowProvider, useNodesState, useReactFlow, type Edge, type Node, type NodeProps } from '@xyflow/react'
import { Plus } from 'lucide-react'
import { completeness, connectionLabels, contextKinds, hasCurrentAnalysis, kindLabels } from '../shared/plan'
import type { Blueprint, MindNode } from '../shared/types'
import type { MapControl } from '../shared/automation'

type CardData = { node: MindNode; canAdd: boolean; onAddChild: (id: string) => void }
type CardNode = Node<CardData, 'mind'>

export const statusLabels: Record<MindNode['status'], string> = { draft: 'Needs detail', ready: 'Ready', queued: 'Queued', building: 'Building', built: 'Built', failed: 'Failed' }

const MindCard = memo(function MindCard({ data, selected }: NodeProps<CardNode>) {
  const { node } = data
  const score = completeness(node)
  return <div className={`mind-card kind-${node.kind} status-${node.status} ${selected ? 'is-selected' : ''}`}>
    <Handle type="target" position={Position.Left} isConnectableStart={false} />
    <div className="mind-card-tags"><b>{kindLabels[node.kind].toUpperCase()}</b><span className={`status-pill ${node.status}`}>{statusLabels[node.status]}</span></div>
    <strong>{node.title}</strong>
    {node.summary && <p>{node.summary}</p>}
    <div className="mind-card-meter" aria-label={`${score.percent}% detailed`}><span style={{ width: `${score.percent}%` }} /></div>
    <small>{score.asked ? `${score.answered}/${score.asked} answered` : hasCurrentAnalysis(node) && node.analysis?.noFollowUps ? 'No follow-ups needed' : 'Not analyzed yet'} · {score.criteria} criteria</small>
    {contextKinds.includes(node.kind) && <small className="instruction-marker">AGENTS.md instructions</small>}
    {node.kind === 'resource' && <small className="instruction-marker">{node.resourceMode === 'external' ? 'External resource' : 'Shared resource contract'} · no agent</small>}
    <Handle type="source" position={Position.Right} className="add-child nodrag" role="button" tabIndex={0} aria-disabled={!data.canAdd}
      isConnectableStart={data.canAdd} isConnectableEnd={false}
      title={data.canAdd ? 'Click to add a child. Drag to empty space to place a child, or onto a node to link it.' : 'This blueprint has reached the 400-node limit.'}
      aria-label={`Add child to ${node.title}`}
      onClick={event => { event.stopPropagation(); if (data.canAdd) data.onAddChild(node.id) }}
      onKeyDown={event => { if (data.canAdd && (event.key === 'Enter' || event.key === ' ')) { event.preventDefault(); event.stopPropagation(); data.onAddChild(node.id) } }}>
      <Plus size={12} />
    </Handle>
  </div>
})

const nodeTypes = { mind: MindCard }

interface Props {
  blueprint: Blueprint
  selectedId?: string
  selectedEdgeId?: string
  locked: boolean
  fitSignal?: number
  onSelect: (id: string) => void
  onAddChild: (parentId: string, position?: MindNode['position']) => void
  onConnect: (sourceId: string, targetId: string) => void
  onSelectEdge: (id?: string) => void
  onMove: (id: string, position: { x: number; y: number }) => void
  onControl?: (control: MapControl | undefined) => void
}

function Canvas({ blueprint, selectedId, selectedEdgeId, locked, fitSignal, onSelect, onAddChild, onConnect, onSelectEdge, onMove, onControl }: Props) {
  const { fitView, getViewport, setViewport, screenToFlowPosition } = useReactFlow()
  const container = useRef<HTMLDivElement>(null)
  const dragStart = useRef<{ x: number; y: number }>(undefined)
  const suppressClickUntil = useRef(0)
  const skipFit = useRef(false)
  useEffect(() => {
    onControl?.({
      fitView: () => fitView({ padding: 0.2, maxZoom: 1 }), getViewport, setViewport,
      getNodeSizes: () => new Map([...container.current?.querySelectorAll<HTMLElement>('.react-flow__node') ?? []].flatMap(element => {
        const card = element.querySelector<HTMLElement>('.mind-card')
        return element.dataset.id && card ? [[element.dataset.id, { width: card.offsetWidth, height: card.offsetHeight }]] : []
      }))
    })
    return () => onControl?.(undefined)
  }, [fitView, getViewport, setViewport, onControl])
  const derived = useMemo<CardNode[]>(() => blueprint.nodes.map(node => ({
    id: node.id, type: 'mind', position: node.position, selected: node.id === selectedId, draggable: !locked,
    data: { node, canAdd: blueprint.nodes.length < 400, onAddChild: id => { if (Date.now() >= suppressClickUntil.current) onAddChild(id) } }
  })), [blueprint.nodes, selectedId, locked, onAddChild])
  const [nodes, setNodes, onNodesChange] = useNodesState<CardNode>(derived)
  useEffect(() => setNodes(current => {
    const previous = new Map(current.map(node => [node.id, node]))
    return derived.map(node => {
      const existing = previous.get(node.id)
      return existing ? { ...existing, ...node, position: existing.dragging ? existing.position : node.position } : node
    })
  }), [derived, setNodes])
  const edges = useMemo<Edge[]>(() => [
    ...blueprint.nodes.filter(node => node.parentId).map(node => ({
      id: `child-${node.id}`, source: node.parentId!, target: node.id, type: 'smoothstep', label: 'child',
      selected: selectedEdgeId === `child-${node.id}`, ariaLabel: `Child relationship to ${node.title}`,
      className: `edge-child ${node.status === 'building' ? 'edge-active' : node.status === 'built' ? 'edge-built' : ''}`
    })),
    ...blueprint.connections.map(link => ({
      id: `link-${link.id}`, source: link.sourceId, target: link.targetId, type: 'default',
      selected: selectedEdgeId === `link-${link.id}`,
      label: connectionLabels[link.kind],
      className: `edge-${link.kind}`,
      markerEnd: link.kind !== 'similar' ? { type: MarkerType.ArrowClosed, color: `var(--connection-${link.kind})` } : undefined,
      ariaLabel: link.kind === 'dependency'
        ? `${blueprint.nodes.find(node => node.id === link.sourceId)?.title} supplies input to ${blueprint.nodes.find(node => node.id === link.targetId)?.title}`
        : `${blueprint.nodes.find(node => node.id === link.sourceId)?.title} ${link.kind === 'similar' ? 'is similar to' : link.kind} ${blueprint.nodes.find(node => node.id === link.targetId)?.title}`
    }))
  ], [blueprint.nodes, blueprint.connections, selectedEdgeId])
  useEffect(() => {
    if (skipFit.current) { skipFit.current = false; return }
    const timer = setTimeout(() => void fitView({ padding: 0.2, maxZoom: 1, duration: 250 }), 60)
    return () => clearTimeout(timer)
  }, [blueprint.id, blueprint.nodes.length, fitSignal, fitView])

  return <ReactFlow ref={container} nodes={nodes} edges={edges} nodeTypes={nodeTypes} onNodesChange={onNodesChange} fitView fitViewOptions={{ padding: 0.2, maxZoom: 1 }} minZoom={0.2} maxZoom={1.6}
    onNodeClick={(_, node) => onSelect(node.id)} onNodeDragStop={(_, node) => onMove(node.id, node.position)}
    onEdgeClick={(_, edge) => onSelectEdge(edge.id)} onPaneClick={() => onSelectEdge(undefined)}
    onEdgesChange={changes => { const selected = changes.find(change => change.type === 'select' && change.selected); if (selected?.type === 'select') onSelectEdge(selected.id) }}
    onConnectStart={event => {
      const point = 'touches' in event ? event.touches[0] : event
      dragStart.current = point ? { x: point.clientX, y: point.clientY } : undefined
    }}
    onConnectEnd={(event, connection) => {
      const point = 'changedTouches' in event ? event.changedTouches[0] : event
      const from = connection.fromNode?.id
      if (!from || !point || !dragStart.current || Math.hypot(point.clientX - dragStart.current.x, point.clientY - dragStart.current.y) < 6) return
      suppressClickUntil.current = Date.now() + 250
      const element = document.elementFromPoint(point.clientX, point.clientY)
      const target = element?.closest<HTMLElement>('.react-flow__node')?.dataset.id
      if (target) { if (target !== from) onConnect(from, target); return }
      if (!element?.closest('.react-flow__pane') || element.closest('.react-flow__controls')) return
      const position = screenToFlowPosition({ x: point.clientX, y: point.clientY })
      skipFit.current = true
      onAddChild(from, { x: position.x, y: position.y })
    }}
    nodesConnectable connectOnClick={false} connectionDragThreshold={3} proOptions={{ hideAttribution: true }} deleteKeyCode={null}>
    <Background variant={BackgroundVariant.Dots} gap={22} size={1} />
    <Controls showInteractive={false} position="top-right" />
  </ReactFlow>
}

export function MindMap(props: Props) {
  return <ReactFlowProvider><Canvas {...props} /></ReactFlowProvider>
}
