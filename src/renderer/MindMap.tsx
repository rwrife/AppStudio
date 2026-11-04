import { memo, useEffect, useMemo } from 'react'
import { Background, BackgroundVariant, Controls, Handle, Position, ReactFlow, ReactFlowProvider, useNodesState, useReactFlow, type Edge, type Node, type NodeProps } from '@xyflow/react'
import { Plus } from 'lucide-react'
import { completeness, kindLabels } from '../shared/plan'
import type { Blueprint, MindNode } from '../shared/types'

type CardData = { node: MindNode; locked: boolean; onAddChild: (id: string) => void }
type CardNode = Node<CardData, 'mind'>

export const statusLabels: Record<MindNode['status'], string> = { draft: 'Needs detail', ready: 'Ready', queued: 'Queued', building: 'Building', built: 'Built', failed: 'Failed' }

const MindCard = memo(function MindCard({ data, selected }: NodeProps<CardNode>) {
  const { node } = data
  const score = completeness(node)
  return <div className={`mind-card kind-${node.kind} status-${node.status} ${selected ? 'is-selected' : ''}`}>
    {node.parentId && <Handle type="target" position={Position.Left} isConnectable={false} />}
    <div className="mind-card-tags"><b>{kindLabels[node.kind].toUpperCase()}</b><span className={`status-pill ${node.status}`}>{statusLabels[node.status]}</span></div>
    <strong>{node.title}</strong>
    {node.summary && <p>{node.summary}</p>}
    <div className="mind-card-meter" aria-label={`${score.percent}% detailed`}><span style={{ width: `${score.percent}%` }} /></div>
    <small>{score.asked ? `${score.answered}/${score.asked} answered` : 'No questions yet'} · {score.criteria} criteria</small>
    {!data.locked && <button className="add-child nodrag" title="Add child node" aria-label={`Add child to ${node.title}`} onClick={event => { event.stopPropagation(); data.onAddChild(node.id) }}><Plus size={12} /></button>}
    <Handle type="source" position={Position.Right} isConnectable={false} />
  </div>
})

const nodeTypes = { mind: MindCard }

interface Props {
  blueprint: Blueprint
  selectedId?: string
  locked: boolean
  fitSignal?: number
  onSelect: (id: string) => void
  onAddChild: (parentId: string) => void
  onMove: (id: string, position: { x: number; y: number }) => void
}

function Canvas({ blueprint, selectedId, locked, fitSignal, onSelect, onAddChild, onMove }: Props) {
  const { fitView } = useReactFlow()
  const derived = useMemo<CardNode[]>(() => blueprint.nodes.map(node => ({
    id: node.id, type: 'mind', position: node.position, selected: node.id === selectedId, draggable: !locked,
    data: { node, locked, onAddChild }
  })), [blueprint.nodes, selectedId, locked, onAddChild])
  const [nodes, setNodes, onNodesChange] = useNodesState<CardNode>(derived)
  useEffect(() => setNodes(derived), [derived, setNodes])
  const edges = useMemo<Edge[]>(() => blueprint.nodes.filter(node => node.parentId).map(node => ({
    id: `${node.parentId}-${node.id}`, source: node.parentId!, target: node.id, type: 'smoothstep',
    className: node.status === 'building' ? 'edge-active' : node.status === 'built' ? 'edge-built' : ''
  })), [blueprint.nodes])
  useEffect(() => { const timer = setTimeout(() => void fitView({ padding: 0.2, maxZoom: 1, duration: 250 }), 60); return () => clearTimeout(timer) }, [blueprint.id, blueprint.nodes.length, fitSignal, fitView])

  return <ReactFlow nodes={nodes} edges={edges} nodeTypes={nodeTypes} onNodesChange={onNodesChange} fitView fitViewOptions={{ padding: 0.2, maxZoom: 1 }} minZoom={0.2} maxZoom={1.6}
    onNodeClick={(_, node) => onSelect(node.id)} onNodeDragStop={(_, node) => onMove(node.id, node.position)}
    nodesConnectable={false} proOptions={{ hideAttribution: true }} deleteKeyCode={null}>
    <Background variant={BackgroundVariant.Dots} gap={22} size={1} />
    <Controls showInteractive={false} position="top-right" />
  </ReactFlow>
}

export function MindMap(props: Props) {
  return <ReactFlowProvider><Canvas {...props} /></ReactFlowProvider>
}
