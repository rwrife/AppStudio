import { useState } from 'react'
import { CircleAlert, CircleCheck, LoaderCircle, Plus, RefreshCw, X, Zap } from 'lucide-react'
import { endpointSchema, modelIdSchema, type ProviderId, type ProviderInfo, type ProviderSettings } from '../shared/types'
import { errorText } from './App'

const localServers = [
  { name: 'LM Studio', url: 'http://127.0.0.1:1234/v1' },
  { name: 'Ollama', url: 'http://127.0.0.1:11434/v1' },
  { name: 'vLLM', url: 'http://127.0.0.1:8000/v1' },
  { name: 'llama.cpp', url: 'http://127.0.0.1:8080/v1' }
]

interface Props {
  settings: ProviderSettings
  providers: ProviderInfo[]
  onClose: () => void
  onRefresh: () => Promise<void>
  onSaved: (settings: ProviderSettings) => void
}

export function SettingsModal({ settings, providers, onClose, onRefresh, onSaved }: Props) {
  const [draft, setDraft] = useState<ProviderSettings>(() => structuredClone(settings))
  const [newModel, setNewModel] = useState('')
  const [status, setStatus] = useState<{ kind: 'ok' | 'error' | 'busy'; text: string }>()
  const id = draft.provider
  const info = providers.find(item => item.id === id)
  const models = draft.models[id] ?? []
  const modelError = newModel && !modelIdSchema.safeParse(newModel).success ? 'Use letters, digits and . _ : / @ - only.' : ''

  const update = (change: (value: ProviderSettings) => void) => setDraft(current => { const next = structuredClone(current); change(next); return next })
  const addModel = (value: string) => {
    const model = value.trim()
    if (!modelIdSchema.safeParse(model).success) return
    update(next => { next.models[id] = [...new Set([...(next.models[id] ?? []), model])]; next.selectedModel[id] = model })
    setNewModel('')
  }

  async function save(test = false) {
    setStatus({ kind: 'busy', text: test ? 'Saving and asking the model to reply…' : 'Saving…' })
    try {
      const saved = await window.studio.saveSettings(draft)
      onSaved(saved)
      if (saved.provider === 'local') await onRefresh()
      if (!test) return onClose()
      setStatus({ kind: 'ok', text: await window.studio.testProvider() })
    } catch (reason) { setStatus({ kind: 'error', text: errorText(reason) }) }
  }
  const isLocal = id === 'local'
  const choices = isLocal ? [...new Set([...(info?.serverModels ?? []), ...models])] : models
  const endpointError = draft.localEndpoint && !endpointSchema.safeParse(draft.localEndpoint).success ? 'Use an http:// or https:// URL, e.g. http://127.0.0.1:11434/v1' : ''

  return <div className="modal-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) onClose() }}>
    <div className="settings-modal" role="dialog" aria-modal="true" aria-labelledby="settings-title">
      <div className="modal-heading"><div><span className="section-kicker">SETTINGS</span><h2 id="settings-title">Model & agents</h2></div><button className="icon-button" onClick={onClose} aria-label="Close settings"><X size={16} /></button></div>
      <p className="panel-description">App Studio drives the AI CLI you are already signed in to, or a model running on your own machine. No API keys are stored.</p>

      <div className="section-heading"><span className="section-kicker">PROVIDER</span><button className="text-button" onClick={() => void onRefresh()}><RefreshCw size={12} />Re-detect</button></div>
      <div className="provider-grid">
        {providers.map(item => <button key={item.id} className={`provider-card ${item.id === id ? 'selected' : ''} ${item.installed ? '' : 'missing'}`} onClick={() => update(next => { next.provider = item.id as ProviderId })} aria-pressed={item.id === id}>
          <span className="provider-top"><strong>{item.label}</strong>{item.installed ? <CircleCheck size={14} /> : <CircleAlert size={14} />}</span>
          <small>{item.subscription}</small>
          <em>{item.installed ? (item.version ?? 'Installed') : item.id === 'local' ? 'No server running' : 'Not installed'}</em>
        </button>)}
      </div>

      {info && <div className="checks">
        <div className={`check ${info.installed ? '' : 'blocked'}`}>
          {info.installed ? <CircleCheck size={14} /> : <CircleAlert size={14} />}
          <div><strong>{info.installed ? `${info.label} ${isLocal ? 'server found' : 'is available'}` : isLocal ? 'No local model server found' : `${info.label} CLI not found`}</strong><p>{info.detail}</p>
            {!info.installed && info.installHint && <p>{info.installHint}</p>}
            {info.loginHint && <p>{info.loginHint}</p>}</div>
        </div>
      </div>}

      {isLocal && <>
        <label className="field-label" htmlFor="endpoint">Server<span>OpenAI-compatible /v1 URL</span></label>
        <input id="endpoint" placeholder="Auto-detect LM Studio, Ollama, vLLM or llama.cpp on this PC" value={draft.localEndpoint} maxLength={300} onChange={event => update(next => { next.localEndpoint = event.target.value.trim() })} />
        {endpointError && <p className="modal-error">{endpointError}</p>}
        <div className="prompt-suggestions">
          <button className={!draft.localEndpoint ? 'removable' : ''} onClick={() => update(next => { next.localEndpoint = '' })}>Auto-detect</button>
          {localServers.map(item => <button key={item.url} className={draft.localEndpoint === item.url ? 'removable' : ''} onClick={() => update(next => { next.localEndpoint = item.url })} title={item.url}>{item.name}</button>)}
        </div>
        <p className="fine-print">Blueprint text is sent to this server. vLLM runs on Linux or WSL; point this at its URL (for example http://localhost:8000/v1). Save or test to re-detect models.</p>
      </>}

      <label className="field-label" htmlFor="model">Model<span>{isLocal ? `${info?.serverModels?.length ?? 0} on server` : 'your own model IDs'}</span></label>
      <select id="model" value={draft.selectedModel[id] ?? ''} onChange={event => update(next => { next.selectedModel[id] = event.target.value })}>
        <option value="">{isLocal ? 'First loaded model' : 'CLI default'}</option>
        {choices.map(model => <option key={model} value={model}>{model}</option>)}
      </select>
      <div className="path-field add-model">
        <input aria-label="Add a model ID" placeholder={isLocal ? 'Add a model ID, e.g. qwen3:14b' : 'Add a model ID, e.g. claude-sonnet-5.5'} value={newModel} maxLength={120} onChange={event => setNewModel(event.target.value)} onKeyDown={event => { if (event.key === 'Enter') addModel(newModel) }} />
        <button disabled={!newModel || !!modelError} onClick={() => addModel(newModel)} aria-label="Add model"><Plus size={14} /></button>
      </div>
      {modelError && <p className="modal-error">{modelError}</p>}
      <div className="prompt-suggestions">
        {info?.suggestedModels.filter(model => !models.includes(model)).map(model => <button key={model} onClick={() => addModel(model)}>+ {model}</button>)}
        {models.map(model => <button key={model} className="removable" onClick={() => update(next => { next.models[id] = models.filter(other => other !== model); if (next.selectedModel[id] === model) next.selectedModel[id] = '' })} title="Remove model">{model} <X size={10} /></button>)}
      </div>
      <p className="fine-print">{isLocal ? 'Pick a model the server has downloaded. Models with tool calling (Qwen3, Llama 3.1+, Gemma 4) build best.' : "Model IDs are passed to the CLI's --model flag. Availability depends on your plan; use “Test connection” to confirm."}</p>

      {!isLocal && <>
        <label className="field-label" htmlFor="binary">CLI path<span>optional override</span></label>
        <input id="binary" placeholder={info?.binary || `Auto-detect ${id} on PATH`} value={draft.binaryPaths[id] ?? ''} maxLength={1000} onChange={event => update(next => { next.binaryPaths[id] = event.target.value.trim() })} />
      </>}

      <label className="field-label" htmlFor="parallel">Parallel sub-agents<span>{draft.maxParallelAgents} at once</span></label>
      <input id="parallel" type="range" min={1} max={6} value={draft.maxParallelAgents} onChange={event => update(next => { next.maxParallelAgents = Number(event.target.value) })} />
      <p className="fine-print">{isLocal ? 'Local servers usually answer one request at a time; extra agents queue on your GPU.' : "Each sub-agent is a separate CLI session and uses your subscription's quota."}</p>

      {status && <div className={`banner ${status.kind === 'ok' ? 'success' : status.kind === 'error' ? 'error' : ''}`} role="status">
        {status.kind === 'busy' ? <LoaderCircle size={14} className="spin" /> : status.kind === 'ok' ? <CircleCheck size={14} /> : <CircleAlert size={14} />}<span>{status.text}</span>
      </div>}
      <div className="settings-actions">
        <button className="secondary" disabled={status?.kind === 'busy'} onClick={() => void save(true)}><Zap size={14} />Test connection</button>
        <button className="primary" disabled={status?.kind === 'busy'} onClick={() => void save()}>Save</button>
      </div>
    </div>
  </div>
}
