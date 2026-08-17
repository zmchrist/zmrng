import { useState } from 'react'
import styles from './ClarifyChat.module.css'
import { useAttachments } from '../useAttachments'
import { AttachmentTray } from './AttachmentTray'
import type { Attachment } from '../types'

interface Props {
  onSend: (text: string, attachments?: Attachment[]) => void
  disabled?: boolean
  placeholder?: string
}

export function ClarifyChat({
  onSend,
  disabled,
  placeholder = "Answer the agent's questions…  (⌘↵ to send, drop/paste images)",
}: Props) {
  const [text, setText] = useState('')
  const files = useAttachments()

  const canSend = !!text.trim() || files.attachments.length > 0

  function submit(e: React.FormEvent) {
    e.preventDefault()
    if (!canSend || disabled) return
    onSend(text.trim(), files.attachments.length > 0 ? files.attachments : undefined)
    setText('')
    files.clear()
  }

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      submit(e)
    }
  }

  return (
    <form
      className={styles.bar}
      onSubmit={submit}
      onDrop={files.onDrop}
      onDragOver={(e) => e.preventDefault()}
    >
      {(files.attachments.length > 0 || files.error) && (
        <AttachmentTray
          attachments={files.attachments}
          onRemove={files.remove}
          error={files.error}
        />
      )}
      <div className={styles.row}>
        <textarea
          className={styles.input}
          placeholder={placeholder}
          rows={2}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKeyDown}
          onPaste={files.onPaste}
        />
        <button
          type="submit"
          className={styles.send}
          disabled={disabled || !canSend}
        >
          Send
        </button>
      </div>
    </form>
  )
}
