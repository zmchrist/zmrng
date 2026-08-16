import { useEffect, useState } from 'react'
import styles from './Notes.module.css'
import { api } from '../api'

const NOTES_DIR = '.zmrng/notes'

interface Props {
  taskId: string | null
  selectedPath: string | null
  onOpen: (path: string) => void
}

/** Slugify a user-entered note name into a safe `.md` basename. */
function sanitizeName(raw: string): string {
  const trimmed = raw.trim().replace(/\.md$/i, '')
  const safe = trimmed.replace(/[\\/]+/g, '-').trim()
  return safe ? `${safe}.md` : ''
}

/** Note list tagged with the task id it was fetched for, so a stale list from a
 *  previous selection is never shown against the wrong task. */
interface Loaded {
  id: string
  notes: string[]
}

export function Notes({ taskId, selectedPath, onOpen }: Props) {
  const [loaded, setLoaded] = useState<Loaded | null>(null)
  const [nonce, setNonce] = useState(0)
  const [creating, setCreating] = useState(false)
  const [name, setName] = useState('')
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!taskId) return
    let cancelled = false
    api
      .listNotes(taskId)
      .then((list) => {
        if (!cancelled) setLoaded({ id: taskId, notes: list })
      })
      .catch(() => {
        if (!cancelled) setLoaded({ id: taskId, notes: [] })
      })
    return () => {
      cancelled = true
    }
  }, [taskId, nonce])

  const notes = loaded && loaded.id === taskId ? loaded.notes : null

  if (!taskId) {
    return <div className={styles.empty}>Select a task to keep notes on it.</div>
  }

  const startCreate = () => {
    setError(null)
    setName('')
    setCreating(true)
  }

  const cancelCreate = () => {
    setCreating(false)
    setName('')
    setError(null)
  }

  const submitCreate = async () => {
    const fileName = sanitizeName(name)
    if (!fileName) {
      setError('Enter a name.')
      return
    }
    const notePath = `${NOTES_DIR}/${fileName}`
    try {
      await api.writeFile(taskId, notePath, '')
      setCreating(false)
      setName('')
      setError(null)
      setNonce((n) => n + 1)
      onOpen(notePath)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create note.')
    }
  }

  return (
    <div className={styles.notes}>
      <div className={styles.list}>
        {notes === null ? (
          <div className={styles.empty}>Loading…</div>
        ) : notes.length === 0 && !creating ? (
          <div className={styles.empty}>No notes yet.</div>
        ) : (
          notes.map((fileName) => {
            const notePath = `${NOTES_DIR}/${fileName}`
            const selected = selectedPath === notePath
            return (
              <button
                key={fileName}
                type="button"
                className={`${styles.note} ${selected ? styles.noteSelected : ''}`}
                onClick={() => onOpen(notePath)}
                title={notePath}
              >
                <span className={styles.glyph}>▤</span>
                <span className={styles.label}>{fileName}</span>
              </button>
            )
          })
        )}
      </div>

      {creating ? (
        <div className={styles.createRow}>
          <input
            className={styles.input}
            autoFocus
            value={name}
            placeholder="note name…"
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void submitCreate()
              if (e.key === 'Escape') cancelCreate()
            }}
          />
          <button type="button" className={styles.confirm} onClick={() => void submitCreate()}>
            Create
          </button>
          <button type="button" className={styles.cancel} onClick={cancelCreate}>
            Cancel
          </button>
        </div>
      ) : (
        <button type="button" className={styles.newNote} onClick={startCreate}>
          ＋ New note
        </button>
      )}
      {error && <div className={styles.error}>{error}</div>}
    </div>
  )
}
