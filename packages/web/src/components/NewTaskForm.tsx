import { useState } from 'react'
import styles from './NewTaskForm.module.css'
import {
  DEFAULT_EFFORT,
  DEFAULT_MODEL,
  DEFAULT_STYLE,
  type CaveStyle,
  type EffortLevel,
  type ModelAlias,
} from '../types'

interface Props {
  onCreate: (
    title: string,
    body: string,
    opts: { model: ModelAlias; effort: EffortLevel; style: CaveStyle },
  ) => Promise<void>
}

const MODEL_OPTIONS: ModelAlias[] = ['opus', 'sonnet', 'fable']
const EFFORT_OPTIONS: EffortLevel[] = ['low', 'medium', 'high', 'xhigh', 'max']
const STYLE_OPTIONS: CaveStyle[] = [
  'normal',
  'caveman-lite',
  'caveman-full',
  'caveman-ultra',
  'wenyan-full',
]

export function NewTaskForm({ onCreate }: Props) {
  const [open, setOpen] = useState(false)
  const [title, setTitle] = useState('')
  const [body, setBody] = useState('')
  const [model, setModel] = useState<ModelAlias>(DEFAULT_MODEL)
  const [effort, setEffort] = useState<EffortLevel>(DEFAULT_EFFORT)
  const [style, setStyle] = useState<CaveStyle>(DEFAULT_STYLE)
  const [busy, setBusy] = useState(false)

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    if (!title.trim() || !body.trim() || busy) return
    setBusy(true)
    try {
      await onCreate(title.trim(), body.trim(), { model, effort, style })
      setTitle('')
      setBody('')
      setModel(DEFAULT_MODEL)
      setEffort(DEFAULT_EFFORT)
      setStyle(DEFAULT_STYLE)
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
    <form className={styles.wrap} onSubmit={submit}>
      <input
        className={styles.input}
        placeholder="Task title"
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        autoFocus
      />
      <textarea
        className={styles.textarea}
        placeholder="What should the agent do?"
        rows={4}
        value={body}
        onChange={(e) => setBody(e.target.value)}
      />
      <div className={styles.controls}>
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
          disabled={busy || !title.trim() || !body.trim()}
        >
          {busy ? 'Creating…' : 'Create'}
        </button>
      </div>
    </form>
  )
}
