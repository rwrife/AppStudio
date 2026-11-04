import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Ban, Bot, CircleAlert, CircleCheck, Clock, FolderOpen, Hammer, LoaderCircle, Play, Settings2, Square, TriangleAlert } from 'lucide-react'
import { planBuild } from '../shared/plan'
import type { Blueprint, BuildRun, BuildTask, MindNode, ProviderInfo, ProviderSettings } from '../shared/types'
import { errorText } from './App'

const taskIcons: Record<BuildTask['status'], ReactNode> = {
  waiting: <Clock size={14} />, running: <LoaderCircle size={14} className="spin" />, done: <CircleCheck size={14} />,
  failed: <CircleAlert size={14} />, cancelled: <Ban size={14} />, skipped: <Ban size={14} />
}
const taskLabels: Record<BuildTask['status'], string> = { waiting: 'Waiting', running: 'Running', done: 'Done', failed: 'Failed', cancelled: 'Cancelled', skipped: 'Skipped' }

function duration(task: BuildTask) {
  if (!task.startedAt) return ''
  const seconds = Math.round(((task.finishedAt ? Date.parse(task.finishedAt) : Date.now()) - Date.parse(task.startedAt)) / 1000)
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`
}

export function BuildCenter({ blueprint, run }: { blueprint?: Blueprint; run?: BuildRun }) {
  const tasks = useMemo(() => run?.tasks ?? (blueprint ? planBuild(blueprint) : []), [run, blueprint])
  const [selectedId, setSelectedId] = useState<string>()
  const selected = tasks.find(task => task.id === selectedId) ?? tasks.find(task => task.status === 'running') ?? tasks.find(task => task.status === 'failed') ?? tasks[0]
  const logRef = useRef<HTMLPreElement>(null)
  useEffect(() => { const log = logRef.current; if (log) log.scrollTop = log.scrollHeight }, [selected?.log])
  const phases = [
    { label: 'COORDINATOR', items: tasks.filter(task => task.id === 'foundation') },
    { label: 'NODE SUB-AGENTS', items: tasks.filter(task => task.role === 'agent') },
    { label: 'COORDINATOR', items: tasks.filter(task => task.id === 'integrate') }
  ]
  const titleOf = (id: string) => tasks.find(task => task.id === id)?.title.replace(/^[^:]+: /, '') ?? id

  return <section className="center-panel">
    <div className="scene-heading">
      <div><span className="section-kicker">{run ? 'BUILD RUN' : '03 / BUILD PLAN'}</span><h2>{blueprint?.name ?? 'No blueprint open'}{run && <span className={`file-tag run-${run.status}`}>{run.status.toUpperCase()}</span>}</h2></div>
      {run && <small className="run-meta">{run.provider} · {run.model || 'default model'} · {run.outputDir}</small>}
    </div>
    {!blueprint ? <div className="viewport"><div className="empty-viewport"><h2>Nothing to build yet.</h2><p>Create a blueprint first.</p></div></div> : <>
      {!run && <p className="plan-note">This is the plan agents will follow. The coordinator lays the foundation, data agents go first, features and screens fan out in parallel, then the coordinator integrates and verifies. Rules and constraints are passed to agents as context.</p>}
      <div className="phases">
        {phases.map((phase, index) => <div key={index} className="phase">
          <span className="section-kicker">{String(index + 1).padStart(2, '0')} · {phase.label}<span className="count">{phase.items.length}</span></span>
          <div className="task-grid">
            {phase.items.map(task => <button key={task.id} className={`task-card ${task.status} ${task.id === selected?.id ? 'selected' : ''}`} onClick={() => setSelectedId(task.id)}>
              <span className="task-top">{task.role === 'agent' ? <Bot size={13} /> : <Hammer size={13} />}<em>{taskLabels[task.status]}</em>{taskIcons[task.status]}</span>
              <strong>{task.title}</strong>
              <small>{task.dependsOn.length ? `after ${task.dependsOn.map(titleOf).slice(0, 3).join(', ')}${task.dependsOn.length > 3 ? ` +${task.dependsOn.length - 3}` : ''}` : 'starts first'}</small>
              {task.startedAt && <small className="task-time">{duration(task)}</small>}
            </button>)}
            {!phase.items.length && <p className="fine-print">No buildable nodes yet — add features, screens, data or integrations.</p>}
          </div>
        </div>)}
      </div>
      {selected && <div className="log-panel">
        <div className="log-heading"><span className="section-kicker">AGENT OUTPUT</span><strong>{selected.title}</strong>{selected.error && <span className="log-error"><CircleAlert size={12} />{selected.error.split('\n')[0]}</span>}</div>
        <pre ref={logRef}>{selected.log || selected.error || (run ? 'Waiting to start…' : 'Output appears here once the build starts.')}{selected.error && selected.log ? `\n\n${selected.error}` : ''}</pre>
      </div>}
    </>}
  </section>
}

interface PanelProps {
  blueprint?: Blueprint
  run?: BuildRun
  settings?: ProviderSettings
  provider?: ProviderInfo
  gaps: MindNode[]
  onJump: (id: string) => void
  onError: (message?: string) => void
  onOpenSettings: () => void
}

export function BuildPanel({ blueprint, run, settings, provider, gaps, onJump, onError, onOpenSettings }: PanelProps) {
  const [allowGaps, setAllowGaps] = useState(false)
  const [starting, setStarting] = useState(false)
  if (!blueprint || !settings) return <div><span className="section-kicker">04 / BUILD</span><h2>Build with agents</h2><p className="panel-description">Open a blueprint to plan its build.</p></div>
  const mine = run?.blueprintId === blueprint.id ? run : undefined
  const busyElsewhere = run?.status === 'running' && run.blueprintId !== blueprint.id
  const running = mine?.status === 'running'
  const tasks = mine?.tasks ?? []
  const done = tasks.filter(task => task.status === 'done').length
  const model = settings.selectedModel[settings.provider]
  const canStart = !running && !busyElsewhere && !starting && !!provider?.installed && (!gaps.length || allowGaps)

  async function start() {
    setStarting(true); onError(undefined)
    try { await window.studio.startBuild(blueprint!.id) } catch (reason) { onError(errorText(reason)) } finally { setStarting(false) }
  }

  return <div>
    <span className="section-kicker">04 / BUILD</span>
    <h2>Build with agents</h2>
    <p className="panel-description">A coordinator spins up one sub-agent per node, using your AI subscription's CLI or a model running on your machine.</p>

    <label className="field-label">Model<span>{provider?.subscription}</span></label>
    <button className="model-chip" onClick={onOpenSettings}><span className="tiny-dot" /><span><strong>{provider?.label ?? 'No provider'}</strong><small>{model || (settings.provider === 'local' ? (provider?.serverModels?.[0] ?? 'first loaded model') : 'CLI default model')} · {settings.maxParallelAgents} agents at once</small></span><Settings2 size={14} /></button>
    {provider && !provider.installed && <div className="setup-warning"><TriangleAlert size={14} /><span>{settings.provider === 'local' ? 'No local model server found.' : `${provider.label} CLI not found.`}<small>{provider.installHint}</small></span></div>}

    <label className="field-label">Output folder<span>agents write here</span></label>
    <div className="path-field">
      <input readOnly value={blueprint.outputDir || 'Documents\\App Studio\\…'} title={blueprint.outputDir} />
      <button title="Choose output folder" aria-label="Choose output folder" disabled={running} onClick={() => window.studio.chooseOutputDir(blueprint.id).catch(reason => onError(errorText(reason)))}><FolderOpen size={14} /></button>
    </div>

    {gaps.length > 0 && <div className="warnings">
      <strong><TriangleAlert size={12} />{gaps.length} node{gaps.length === 1 ? '' : 's'} still need detail</strong>
      <p>Agents guess wherever the map is silent. Answer the questions first for better results.</p>
      <div className="gap-links">{gaps.slice(0, 6).map(node => <button key={node.id} onClick={() => onJump(node.id)}>{node.title}</button>)}</div>
      <label className="checkbox"><input type="checkbox" checked={allowGaps} onChange={event => setAllowGaps(event.target.checked)} />Build anyway</label>
    </div>}

    {running ? <div className="job-progress">
      <LoaderCircle size={16} className="spin" />
      <div><strong>BUILDING</strong><p>{done} of {tasks.length} tasks done · {tasks.filter(task => task.status === 'running').length} running</p><div className="progress-track"><span style={{ width: `${tasks.length ? (100 * done) / tasks.length : 0}%` }} /></div></div>
      <button onClick={() => void window.studio.cancelBuild()}><Square size={11} />Stop</button>
    </div> : <button className="primary full" disabled={!canStart} onClick={() => void start()}>
      {starting ? <LoaderCircle size={15} className="spin" /> : <Play size={15} />}{mine ? 'Rebuild with agents' : 'Start build'}
    </button>}
    {busyElsewhere && <p className="fine-print">Another blueprint is building. Wait for it to finish or stop it.</p>}
    {settings.provider !== 'local' && <p className="fine-print">Agents may create files and run commands (for example npm install) inside the output folder without asking. Review the result before running it elsewhere.</p>}
    {settings.provider === 'local' && <p className="fine-print">Local agents can list, read and write files inside the output folder only. They cannot run commands, so install dependencies and run tests yourself.</p>}

    {mine && !running && <div className={`banner ${mine.status === 'done' ? 'success' : 'error'}`}>
      {mine.status === 'done' ? <CircleCheck size={14} /> : <CircleAlert size={14} />}
      <span>{mine.status === 'done' ? `All ${tasks.length} tasks finished. Check BUILD_REPORT.md for how each node meets its criteria.` : `Build ${mine.status}: ${tasks.filter(task => task.status === 'failed').length} failed, ${tasks.filter(task => ['skipped', 'cancelled'].includes(task.status)).length} not run.`}</span>
    </div>}
    <button className="secondary full spaced" onClick={() => window.studio.revealOutput(blueprint.id).catch(reason => onError(errorText(reason)))}><FolderOpen size={14} />Open output folder</button>
  </div>
}
