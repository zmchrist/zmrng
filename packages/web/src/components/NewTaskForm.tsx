import { useState } from 'react'
import styles from './NewTaskForm.module.css'

interface Props {
  onCreate: (title: string, body: string) => Promise<void>
}

export function NewTaskForm({ onCreate }: Props) {
  const [open, setOpen] = useState(false)
  const [title, setTitle] = useState('')
  const [body, setBody] = useState('')
  const [busy, setBusy] = useState(false)

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    if (!title.trim() || !body.trim() || busy) return
    setBusy(true)
    try {
      await onCreate(title.trim(), body.trim())
      setTitle('')
      setBody('')
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
