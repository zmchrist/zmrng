import { useEffect, useState } from 'react'
import styles from './NewTaskForm.module.css'
import { useAttachments } from '../useAttachments'
import { AttachmentTray } from './AttachmentTray'
import { resolveSuggestedRepoId, type HandoffPrefill } from '../teamHandoff'
import {
  DEFAULT_EFFORT,
  DEFAULT_FLOW,
  DEFAULT_MODEL,
  DEFAULT_STYLE,
  type Attachment,
  type CaveStyle,
  type EffortLevel,
  type FlowMode,
  type ModelAlias,
  type RepoTarget,
} from '../types'

interface Props {
  repos: RepoTarget[]
  defaultRepoId: string
  onCreate: (
    title: string,
    body: string,
    opts: {
      model: ModelAlias
      effort: EffortLevel
      style: CaveStyle
      flow: FlowMode
      repoId: string
    },
    attachments?: Attachment[],
  ) => Promise<void>
  /**
   * A one-shot pre-fill from the Team tab's "Send to my zmrng" handoff (T3).
   * Each send passes a fresh object; when its identity changes the form opens
   * and seeds its title/body and a SUGGESTED repo. The suggestion only sets the
   * initial dropdown value if it matches a repo in the LOCAL registry — the
   * human still confirms/changes it (no VPS repo id is auto-bound). Otherwise
   * it falls back to the default (decision D6).
   */
  prefill?: HandoffPrefill | null
  /**
   * Fired after this form has seeded from a fresh `prefill`, so the parent can
   * drop it. Without this, a later remount of the form (hide/show of the card)
   * resets the local seeded marker and would re-seed the already-sent handoff.
   */
  onPrefillConsumed?: () => void
}

const MODEL_OPTIONS: ModelAlias[] = ['opus', 'sonnet']
const EFFORT_OPTIONS: EffortLevel[] = ['low', 'medium', 'high', 'xhigh', 'max']
const STYLE_OPTIONS: CaveStyle[] = [
  'normal',
  'caveman-lite',
  'caveman-full',
  'caveman-ultra',
  'wenyan-full',
]
const FLOW_OPTIONS: FlowMode[] = ['direct', 'plan']

// Snappy defaults per flow: `direct` is for menial work (sonnet · medium),
// `plan` earns the heavier opus · high (the plan phase re-picks these anyway).
const FLOW_DEFAULTS: Record<FlowMode, { model: ModelAlias; effort: EffortLevel }> = {
  direct: { model: 'sonnet', effort: 'medium' },
  plan: { model: DEFAULT_MODEL, effort: DEFAULT_EFFORT },
}

export function NewTaskForm({ repos, defaultRepoId, onCreate, prefill, onPrefillConsumed }: Props) {
  const [open, setOpen] = useState(false)
  const [title, setTitle] = useState('')
  const [body, setBody] = useState('')
  const [flow, setFlow] = useState<FlowMode>(DEFAULT_FLOW)
  const [model, setModel] = useState<ModelAlias>(FLOW_DEFAULTS[DEFAULT_FLOW].model)
  const [effort, setEffort] = useState<EffortLevel>(FLOW_DEFAULTS[DEFAULT_FLOW].effort)
  const [style, setStyle] = useState<CaveStyle>(DEFAULT_STYLE)
  // Last handoff pre-fill we seeded from. A fresh `prefill` object identity (one
  // per "Send to my zmrng" click) re-seeds the form in render — the established
  // "adjust state on a prop change" pattern (see WorkspaceView), avoiding an
  // effect. The suggested repo is resolved against the LOCAL registry only.
  const [seededPrefill, setSeededPrefill] = useState<HandoffPrefill | null>(null)

  // Switching flow snaps model/effort to that flow's snappy defaults; the
  // operator can still override afterward.
  function onFlowChange(next: FlowMode) {
    setFlow(next)
    setModel(FLOW_DEFAULTS[next].model)
    setEffort(FLOW_DEFAULTS[next].effort)
  }
  // '' means "follow the server default" until the operator explicitly picks a repo.
  const [repoId, setRepoId] = useState('')
  const [busy, setBusy] = useState(false)
  const files = useAttachments()

  // Seed from a new "Send to my zmrng" handoff pre-fill (T3). Guarded by object
  // identity so it runs once per send; the human can freely edit afterward.
  if (prefill && prefill !== seededPrefill) {
    setSeededPrefill(prefill)
    setOpen(true)
    setTitle(prefill.title)
    setBody(prefill.body)
    setRepoId(resolveSuggestedRepoId(prefill.suggestedRepoId, repos))
  }

  // Once seeded (render committed), tell the parent to drop the one-shot prefill.
  // Runs after the render-phase seed above; clearing it upstream stops a later
  // remount of this form from re-seeding the same already-sent handoff.
  useEffect(() => {
    if (prefill) onPrefillConsumed?.()
  }, [prefill, onPrefillConsumed])

  const effectiveRepoId = repoId || defaultRepoId
  // A title is always required; an image-only description (no body text) is valid.
  const canSubmit = !!title.trim() && (!!body.trim() || files.attachments.length > 0)

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    if (!canSubmit || busy) return
    setBusy(true)
    try {
      await onCreate(
        title.trim(),
        body.trim(),
        { model, effort, style, flow, repoId: effectiveRepoId },
        files.attachments.length > 0 ? files.attachments : undefined,
      )
      setTitle('')
      setBody('')
      setFlow(DEFAULT_FLOW)
      setModel(FLOW_DEFAULTS[DEFAULT_FLOW].model)
      setEffort(FLOW_DEFAULTS[DEFAULT_FLOW].effort)
      setStyle(DEFAULT_STYLE)
      setRepoId('')
      files.clear()
      setOpen(false)
    } finally {
      setBusy(false)
    }
  }

  if (!open) {
    return (
      <div className={styles.wrap}>
        <button type="button" className={styles.newBtn} onClick={() => setOpen(true)}>
          + New task
        </button>
      </div>
    )
  }

  return (
    <form
      className={styles.wrap}
      onSubmit={submit}
      onDrop={files.onDrop}
      onDragOver={(e) => e.preventDefault()}
    >
      <input
        className={styles.input}
        placeholder="Task title"
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        autoFocus
      />
      <textarea
        className={styles.textarea}
        placeholder="What should the agent do?  (drop or paste images / PDFs)"
        rows={4}
        value={body}
        onChange={(e) => setBody(e.target.value)}
        onPaste={files.onPaste}
      />
      <AttachmentTray
        attachments={files.attachments}
        onRemove={files.remove}
        error={files.error}
      />
      <div className={styles.controls}>
        <label className={styles.control}>
          <span className={styles.controlLabel}>Flow</span>
          <select
            className={styles.select}
            value={flow}
            onChange={(e) => onFlowChange(e.target.value as FlowMode)}
          >
            {FLOW_OPTIONS.map((f) => (
              <option key={f} value={f}>
                {f === 'direct' ? 'direct (skip plan)' : 'plan (full pipeline)'}
              </option>
            ))}
          </select>
        </label>
        <label className={styles.control}>
          <span className={styles.controlLabel}>Repo</span>
          <select
            className={styles.select}
            value={effectiveRepoId}
            onChange={(e) => setRepoId(e.target.value)}
            disabled={repos.length === 0}
          >
            {repos.map((r) => (
              <option key={r.id} value={r.id}>
                {r.label}
              </option>
            ))}
          </select>
        </label>
        <label className={styles.control}>
          <span className={styles.controlLabel}>Model</span>
          <select
            className={styles.select}
            value={model}
            onChange={(e) => setModel(e.target.value as ModelAlias)}
          >
            {MODEL_OPTIONS.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </select>
        </label>
        <label className={styles.control}>
          <span className={styles.controlLabel}>Effort</span>
          <select
            className={styles.select}
            value={effort}
            onChange={(e) => setEffort(e.target.value as EffortLevel)}
          >
            {EFFORT_OPTIONS.map((eff) => (
              <option key={eff} value={eff}>
                {eff}
              </option>
            ))}
          </select>
        </label>
        <label className={styles.control}>
          <span className={styles.controlLabel}>Style</span>
          <select
            className={styles.select}
            value={style}
            onChange={(e) => setStyle(e.target.value as CaveStyle)}
          >
            {STYLE_OPTIONS.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </label>
      </div>
      <div className={styles.actions}>
        <button type="button" className={styles.ghost} onClick={() => setOpen(false)}>
          Cancel
        </button>
        <button
          type="submit"
          className={styles.primary}
          disabled={busy || !canSubmit}
        >
          {busy ? 'Creating…' : 'Create'}
        </button>
      </div>
    </form>
  )
}
