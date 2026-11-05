import { ArrowLeftRight, Trash2 } from 'lucide-react'
import { descendantIds } from '../shared/plan'
import type { Blueprint, MindNode, NodeConnection } from '../shared/types'

interface Props {
  blueprint: Blueprint
  connection?: NodeConnection
  child?: MindNode
  locked: boolean
  onChange: (patch: Partial<Omit<NodeConnection, 'id'>>) => void
  onReparent: (parentId: string) => void
  onDelete: () => void
}

export function RelationshipInspector({ blueprint, connection, child, locked, onChange, onReparent, onDelete }: Props) {
  if (child) {
    const excluded = descendantIds(blueprint, child.id)
    excluded.add(child.id)
    return <section aria-label="Relationship properties">
      <span className="section-kicker">RELATIONSHIP</span><h2>Parent and child</h2>
      <p className="panel-description">This line defines the node hierarchy. Change its parent here. Use the + point to add a separate dependency or similarity relationship.</p>
      <label className="field-label" htmlFor="relationship-parent">Parent</label>
      <select id="relationship-parent" disabled={locked} value={child.parentId ?? ''} onChange={event => onReparent(event.target.value)}>
        {blueprint.nodes.filter(node => !excluded.has(node.id)).map(node => <option key={node.id} value={node.id}>{node.title}</option>)}
      </select>
      <label className="field-label">Child</label><p>{child.title}</p>
      <p className="fine-print">Direction is always parent to child. Hierarchy lines cannot be reversed or converted into cross-links because every non-root node needs one parent.</p>
      {locked && <p className="fine-print">Stop the active operation before changing an existing build requirement.</p>}
    </section>
  }
  if (!connection) return null
  const resourceLink = connection.kind === 'defines' || connection.kind === 'references'
  const descriptions: Record<NodeConnection['kind'], string> = {
    dependency: 'The source produces output consumed by the target. It builds first. Cycles and dependencies involving instruction-only nodes or resources are rejected.',
    similar: 'Similarity shares context in both directions. It does not impose build order.',
    defines: 'The source owns creation of the target Resource. Each managed resource has one Defines owner. App and Architecture owners use foundation; code-output owners use their own tasks.',
    references: 'The source consumes the target Resource and waits for its defining task. Externally provided resources are not created by an agent.'
  }
  return <section aria-label="Relationship properties">
    <span className="section-kicker">RELATIONSHIP</span><h2>Connection properties</h2>
    <label className="field-label" htmlFor="relationship-type">Relationship type</label>
    <select id="relationship-type" value={connection.kind} disabled={locked} onChange={event => onChange({ kind: event.target.value as NodeConnection['kind'] })}>
      <option value="dependency">Dependency (output to input)</option><option value="similar">Similarity (shared context)</option>
      <option value="defines">Defines (owner to resource)</option><option value="references">References (consumer to resource)</option>
    </select>
    <p className="fine-print">{descriptions[connection.kind]}</p>
    <label className="field-label" htmlFor="relationship-source">{connection.kind === 'defines' ? 'Source (owner)' : connection.kind === 'references' ? 'Source (consumer)' : connection.kind === 'dependency' ? 'Source (producer)' : 'First node'}</label>
    <select id="relationship-source" value={connection.sourceId} disabled={locked} onChange={event => onChange({ sourceId: event.target.value })}>
      {blueprint.nodes.filter(node => node.id !== connection.targetId).map(node => <option key={node.id} value={node.id}>{node.title}</option>)}
    </select>
    <label className="field-label" htmlFor="relationship-target">{resourceLink ? 'Target (resource)' : connection.kind === 'dependency' ? 'Target (consumer)' : 'Second node'}</label>
    <select id="relationship-target" value={connection.targetId} disabled={locked} onChange={event => onChange({ targetId: event.target.value })}>
      {blueprint.nodes.filter(node => node.id !== connection.sourceId).map(node => <option key={node.id} value={node.id}>{node.title}</option>)}
    </select>
    <button className="secondary full spaced" disabled={locked || connection.kind !== 'dependency'} onClick={() => onChange({ sourceId: connection.targetId, targetId: connection.sourceId })}><ArrowLeftRight size={14} />Reverse direction</button>
    {resourceLink && <p className="fine-print">Resource links always point from a non-resource node to a Resource. Change the owner or consumer rather than reversing the line.</p>}
    {locked && <p className="fine-print">Stop the active operation before changing a relationship in its build plan.</p>}
    <button className="text-button full danger spaced" disabled={locked} onClick={onDelete}><Trash2 size={14} />Remove relationship</button>
  </section>
}
