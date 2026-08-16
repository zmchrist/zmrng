import { Suspense, lazy, useCallback, useEffect, useState } from 'react'
import styles from './Viewer.module.css'
import type { WorktreeFileContent } from '../types'
import { api } from '../api'
import { renderMarkdown } from './renderMarkdown'

// CodeMirror (+ its language packages) and pdf.js are both heavy — lazy-load
// each so the main bundle only pays for whichever format is actually opened.
const PdfViewer = lazy(() => import('./PdfViewer').then((m) => ({ default: m.PdfViewer })))
const CodeEditor = lazy(() => import('./CodeEditor').then((m) => ({ default: m.CodeEditor })))

interface Props {
  taskId: string | null
  path: string | null
}

/** Markdown files render either the editor or the rendered preview, one at a
 *  time — never side by side. Defaults to the editor. */
type MarkdownView = 'edit' | 'preview'

function mimeForImage(path: string): string {
  const ext = path.split('.').pop()?.toLowerCase() ?? ''
  switch (ext) {
    case 'png':
      return 'image/png'
    case 'jpg':
    case 'jpeg':
      return 'image/jpeg'
    case 'gif':
      return 'image/gif'
    case 'svg':
      return 'image/svg+xml'
    case 'webp':
      return 'image/webp'
    default:
      return 'application/octet-stream'
  }
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/** Format-dispatched body: markdown shows the editor or the rendered preview
 *  (one at a time, toggled from the bar), code/text an editor only, image/pdf a
 *  read-only render. */
function ViewerBody({
  file,
  path,
  draft,
  onDraftChange,
  mdView,
}: {
  file: WorktreeFileContent
  path: string
  draft: string
  onDraftChange: (v: string) => void
  mdView: MarkdownView
}) {
  if (file.format === 'image') {
    return (
      <div className={styles.imageWrap}>
        <img src={`data:${mimeForImage(path)};base64,${file.content}`} alt={path} className={styles.image} />
      </div>
    )
  }
  if (file.format === 'pdf') {
    return (
      <Suspense fallback={<div className={styles.loading}>Loading PDF…</div>}>
        <PdfViewer base64={file.content} />
      </Suspense>
    )
  }
  if (file.format === 'markdown' && mdView === 'preview') {
    // Escaped in renderMarkdown before any tag is introduced — safe to inject.
    return <div className={styles.preview} dangerouslySetInnerHTML={{ __html: renderMarkdown(draft) }} />
  }
  return (
    <Suspense fallback={<div className={styles.loading}>Loading editor…</div>}>
      <CodeEditor key={path} path={path} initialValue={draft} onChange={onDraftChange} />
    </Suspense>
  )
}

/** A fetch result tagged with the (taskId, path) it was fetched for, so a
 *  fetch that lands after the user opened a different file is never shown.
 *  `taskId` is null when the file was read from the Projects dir (no task). */
interface Fetched {
  taskId: string | null
  path: string
  file: WorktreeFileContent | null
  error: string | null
}

/** Format-dispatched viewer/editor for the Workspace center dock: markdown +
 *  code are read-write via CodeMirror 6, images render natively, PDFs via
 *  pdf.js — all read-only. Edits save into the task's worktree over the
 *  server's file endpoint (a real `git status`-visible write, not a scratch
 *  buffer). */
export function Viewer({ taskId, path }: Props) {
  const [fetched, setFetched] = useState<Fetched | null>(null)
  const [draft, setDraft] = useState('')
  const [saving, setSaving] = useState(false)
  const [mdView, setMdView] = useState<MarkdownView>('edit')

  useEffect(() => {
    if (!path) return
    let cancelled = false
    // With a task, read/write its worktree; with no task, read-only from the
    // Projects dir (arbitrary project browsing).
    const read = taskId ? api.readFile(taskId, path) : api.readProjectFile(path)
    read
      .then((f) => {
        if (cancelled) return
        setFetched({ taskId, path, file: f, error: null })
        setDraft(f.encoding === 'utf8' ? f.content : '')
        setMdView('edit')
      })
      .catch((err) => {
        if (!cancelled) setFetched({ taskId, path, file: null, error: errMsg(err) })
      })
    return () => {
      cancelled = true
    }
  }, [taskId, path])

  const current = fetched && fetched.taskId === taskId && fetched.path === path ? fetched : null
  const loading = !!path && !current
  const error = current?.error ?? null
  const file = current?.file ?? null

  // Only a task worktree is writable; Projects-dir files are read-only.
  const editable = !!taskId && file?.encoding === 'utf8'
  const dirty = editable && draft !== file.content

  const save = useCallback(() => {
    if (!taskId || !path || !file || file.encoding !== 'utf8') return
    setSaving(true)
    api
      .writeFile(taskId, path, draft)
      .then(() => {
        setFetched({ taskId, path, file: { ...file, content: draft }, error: null })
      })
      .catch((err) => {
        setFetched({ taskId, path, file, error: errMsg(err) })
      })
      .finally(() => setSaving(false))
  }, [taskId, path, file, draft])

  useEffect(() => {
    if (!editable) return
    function onKeyDown(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key === 's') {
        e.preventDefault()
        save()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [editable, save])

  if (!path) {
    return (
      <div className={styles.dockSlot}>
        Viewer — open a file to preview it here.
        <span className={styles.dockSlotSub}>Markdown + code edit, images + PDF preview.</span>
      </div>
    )
  }

  return (
    <div className={styles.root}>
      <div className={styles.bar}>
        <span className={styles.filePath} title={path}>
          {path}
        </span>
        {file && !editable && <span className={styles.badge}>read-only</span>}
        {file?.format === 'markdown' && (
          <button
            type="button"
            className={styles.toggleBtn}
            onClick={() => setMdView((v) => (v === 'edit' ? 'preview' : 'edit'))}
            title={mdView === 'edit' ? 'Show rendered preview' : 'Show editor'}
          >
            {mdView === 'edit' ? 'Preview' : 'Edit'}
          </button>
        )}
        {editable && (
          <button
            type="button"
            className={styles.saveBtn}
            onClick={save}
            disabled={!dirty || saving}
            title="Save (Cmd/Ctrl+S)"
          >
            {saving ? 'Saving…' : dirty ? 'Save*' : 'Saved'}
          </button>
        )}
      </div>
      <div className={styles.body}>
        {loading && <div className={styles.loading}>Loading…</div>}
        {!loading && error && <div className={styles.error}>{error}</div>}
        {!loading && !error && file && (
          <ViewerBody file={file} path={path} draft={draft} onDraftChange={setDraft} mdView={mdView} />
        )}
      </div>
    </div>
  )
}
