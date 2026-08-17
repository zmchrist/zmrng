// Shared attachment state + paste/drop handlers for the three composers
// (NewTaskForm, ClarifyChat, ChatPane). Keeps the drop/paste glue DRY: each
// composer just spreads `onPaste`/`onDrop` onto its textarea and renders the
// tray. Enforces the count cap and surfaces the first validation error.

import { useCallback, useState } from 'react'
import {
  fileToAttachment,
  filesFromDrop,
  filesFromPaste,
  validateFile,
} from './attachments'
import { MAX_ATTACHMENTS, type Attachment } from './types'

export interface UseAttachments {
  attachments: Attachment[]
  /** Validate + read files, appending the survivors (up to the count cap). */
  addFiles: (files: File[]) => Promise<void>
  remove: (index: number) => void
  clear: () => void
  error: string | null
  onPaste: (e: React.ClipboardEvent) => void
  onDrop: (e: React.DragEvent) => void
}

export function useAttachments(): UseAttachments {
  const [attachments, setAttachments] = useState<Attachment[]>([])
  const [error, setError] = useState<string | null>(null)

  const addFiles = useCallback(async (files: File[]) => {
    if (files.length === 0) return
    setError(null)
    const accepted: Attachment[] = []
    let firstError: string | null = null
    for (const file of files) {
      const err = validateFile(file)
      if (err) {
        firstError ??= err
        continue
      }
      try {
        accepted.push(await fileToAttachment(file))
      } catch {
        firstError ??= `${file.name || 'file'}: could not be read`
      }
    }
    setAttachments((prev) => {
      const room = MAX_ATTACHMENTS - prev.length
      if (accepted.length > room) firstError ??= `at most ${MAX_ATTACHMENTS} attachments`
      return room <= 0 ? prev : [...prev, ...accepted.slice(0, room)]
    })
    if (firstError) setError(firstError)
  }, [])

  const remove = useCallback((index: number) => {
    setAttachments((prev) => prev.filter((_, i) => i !== index))
  }, [])

  const clear = useCallback(() => {
    setAttachments([])
    setError(null)
  }, [])

  const onPaste = useCallback(
    (e: React.ClipboardEvent) => {
      const files = filesFromPaste(e)
      if (files.length > 0) {
        e.preventDefault()
        void addFiles(files)
      }
    },
    [addFiles],
  )

  const onDrop = useCallback(
    (e: React.DragEvent) => {
      const files = filesFromDrop(e)
      if (files.length > 0) {
        e.preventDefault()
        void addFiles(files)
      }
    },
    [addFiles],
  )

  return { attachments, addFiles, remove, clear, error, onPaste, onDrop }
}
